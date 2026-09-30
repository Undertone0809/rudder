import type { Db } from "@rudderhq/db";
import {
  agentIntegrationChatBindings,
  agentIntegrations,
  chatContextLinks,
  chatConversationUserStates,
  chatConversations,
  chatMessages,
  runtimeBindings,
} from "@rudderhq/db";
import { shortRefFor, type ChatRuntimeContinuity } from "@rudderhq/shared";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  listActiveChatGenerationIds,
  listPendingChatProposalConversationIds,
} from "./chats.attention-order.js";
import { conversationMutability } from "./chats.fork-helpers.js";
import {
  buildSearchSnippet,
  escapeLikePattern,
  incomingMessagePreviewSql,
  listContextLinksForConversationIds,
  listPrimaryIssues,
  textContains,
  truncatePreview,
  visibleIncomingMessageSql,
} from "./chats.helpers.js";
import type { ConversationSourceMetadata, ConversationSummaryCursor } from "./chats.types.js";

type ConversationRow = typeof chatConversations.$inferSelect;
type ConversationUserStateRow = typeof chatConversationUserStates.$inferSelect;

function chatShortRef(id: string): string | null {
  try {
    return shortRefFor("chat", id);
  } catch {
    return null;
  }
}

async function listRuntimeContinuityByConversationId(
  db: Db,
  orgId: string,
  conversationIds: string[],
): Promise<Map<string, ChatRuntimeContinuity>> {
  if (conversationIds.length === 0) return new Map<string, ChatRuntimeContinuity>();
  const rows = await db
    .select({
      conversationId: runtimeBindings.conversationId,
      continuity: runtimeBindings.continuity,
    })
    .from(runtimeBindings)
    .where(and(
      eq(runtimeBindings.orgId, orgId),
      eq(runtimeBindings.status, "active"),
      inArray(runtimeBindings.conversationId, conversationIds),
    ));
  return new Map(
    rows.flatMap((row) => row.conversationId
      ? [[row.conversationId, row.continuity] as const]
      : []),
  );
}

export function createChatConversationListingService(db: Db) {
  async function ensureConversationUserStates(rows: ConversationRow[], userId: string) {
    if (rows.length === 0) return;
    const now = new Date();
    await db.transaction(async (tx) => {
      // Listing snapshots may outlive a concurrent conversation deletion.
      // Lock surviving parents through the insert, rather than catching FK
      // errors or dropping state initialization for the rest of the batch.
      const parents = await tx.select({ id: chatConversations.id, orgId: chatConversations.orgId }).from(chatConversations)
        .where(or(...rows.map((row) => and(
          eq(chatConversations.orgId, row.orgId), eq(chatConversations.id, row.id),
        )))).orderBy(asc(chatConversations.id)).for("key share");
      const parentIds = new Set(parents.map((row) => `${row.orgId}:${row.id}`));
      const survivingRows = rows.filter((row) => parentIds.has(`${row.orgId}:${row.id}`));
      if (!survivingRows.length) return;
      await tx.insert(chatConversationUserStates)
        .values(
          survivingRows.map((row) => ({
            orgId: row.orgId,
            conversationId: row.id,
            userId,
            lastReadAt: row.lastMessageAt ?? row.updatedAt ?? row.createdAt,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing();
    });
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
          sql<boolean>`not exists (
            select 1
            from ${agentIntegrationChatBindings}
            where ${agentIntegrationChatBindings.orgId} = ${orgId}
              and ${agentIntegrationChatBindings.conversationId} = ${chatMessages.conversationId}
          )`,
        ),
      )
      .groupBy(chatMessages.conversationId);
    return new Map(rows.map((row) => [row.conversationId, Number(row.count ?? 0)]));
  }

  async function listConversationSourceMetadata(orgId: string, conversationIds: string[]) {
    if (conversationIds.length === 0) return new Map<string, ConversationSourceMetadata>();
    const rows = await db
      .select({
        conversationId: agentIntegrationChatBindings.conversationId,
        integrationId: agentIntegrationChatBindings.integrationId,
        provider: agentIntegrations.provider,
        externalChatId: agentIntegrationChatBindings.externalChatId,
        externalChatType: agentIntegrationChatBindings.externalChatType,
      })
      .from(agentIntegrationChatBindings)
      .innerJoin(agentIntegrations, eq(agentIntegrations.id, agentIntegrationChatBindings.integrationId))
      .where(
        and(
          eq(agentIntegrationChatBindings.orgId, orgId),
          inArray(agentIntegrationChatBindings.conversationId, conversationIds),
        ),
      )
      .orderBy(agentIntegrationChatBindings.createdAt);
    const map = new Map<string, ConversationSourceMetadata>();
    for (const row of rows) {
      if (map.has(row.conversationId)) continue;
      map.set(row.conversationId, {
        source: "agent_integration",
        provider: row.provider,
        integrationId: row.integrationId,
        externalChatId: row.externalChatId,
        externalChatType: row.externalChatType,
      });
    }
    const missingConversationIds = conversationIds.filter((id) => !map.has(id));
    if (missingConversationIds.length === 0) return map;

    const historicalRows = await db
      .select({
        conversationId: chatMessages.conversationId,
        payload: chatMessages.structuredPayload,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          inArray(chatMessages.conversationId, missingConversationIds),
          sql<boolean>`${chatMessages.structuredPayload}->>'source' = 'agent_integration'`,
          sql<boolean>`${chatMessages.structuredPayload}->>'provider' = 'feishu'`,
        ),
      )
      .orderBy(chatMessages.createdAt);
    for (const row of historicalRows) {
      if (map.has(row.conversationId)) continue;
      const payload = row.payload ?? {};
      const integrationId = typeof payload.integrationId === "string" ? payload.integrationId : null;
      const externalChatId = typeof payload.externalChatId === "string" ? payload.externalChatId : null;
      const externalChatType = typeof payload.externalChatType === "string" ? payload.externalChatType : null;
      if (!integrationId || !externalChatId || !externalChatType) continue;
      map.set(row.conversationId, {
        source: "agent_integration",
        provider: "feishu",
        integrationId,
        externalChatId,
        externalChatType,
      });
    }
    return map;
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
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id));

    const map = new Map<string, string | null>();
    for (const row of rows) {
      if (!map.has(row.conversationId)) {
        map.set(row.conversationId, truncatePreview(row.body));
      }
    }
    return map;
  }

  async function listUserMessageSummaries(orgId: string, conversationIds: string[]) {
    if (conversationIds.length === 0) return new Map<string, { count: number; latestPreview: string | null }>();

    const countRows = await db
      .select({
        conversationId: chatMessages.conversationId,
        count: sql<number>`count(*)`,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          inArray(chatMessages.conversationId, conversationIds),
          isNull(chatMessages.supersededAt),
          eq(chatMessages.role, "user"),
          eq(chatMessages.kind, "message"),
          sql<boolean>`btrim(${chatMessages.body}) <> ''`,
        ),
      )
      .groupBy(chatMessages.conversationId);

    const latestUserAt = db
      .select({
        conversationId: chatMessages.conversationId,
        latestUserAt: sql<Date>`max(${chatMessages.createdAt})`.as("latest_user_at"),
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          inArray(chatMessages.conversationId, conversationIds),
          isNull(chatMessages.supersededAt),
          eq(chatMessages.role, "user"),
          eq(chatMessages.kind, "message"),
          sql<boolean>`btrim(${chatMessages.body}) <> ''`,
        ),
      )
      .groupBy(chatMessages.conversationId)
      .as("latest_chat_user_at");

    const previewRows = await db
      .select({
        conversationId: chatMessages.conversationId,
        body: chatMessages.body,
      })
      .from(chatMessages)
      .innerJoin(
        latestUserAt,
        and(
          eq(chatMessages.conversationId, latestUserAt.conversationId),
          eq(chatMessages.createdAt, latestUserAt.latestUserAt),
        ),
      )
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          inArray(chatMessages.conversationId, conversationIds),
          isNull(chatMessages.supersededAt),
          eq(chatMessages.role, "user"),
          eq(chatMessages.kind, "message"),
          sql<boolean>`btrim(${chatMessages.body}) <> ''`,
        ),
      )
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id));

    const map = new Map<string, { count: number; latestPreview: string | null }>();
    for (const row of countRows) {
      map.set(row.conversationId, { count: Number(row.count ?? 0), latestPreview: null });
    }
    for (const row of previewRows) {
      const current = map.get(row.conversationId) ?? { count: 0, latestPreview: null };
      if (!current.latestPreview) {
        map.set(row.conversationId, { ...current, latestPreview: truncatePreview(row.body) });
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
    const sourceLookupConversationIds = [
      ...new Set([
        ...conversationIds,
        ...rows.flatMap((row) => [row.forkedFromConversationId, row.forkRootConversationId].filter((id): id is string => Boolean(id))),
      ]),
    ];
    const orgId = rows[0]?.orgId ?? null;

    const [
      contextLinksByConversationId,
      primaryIssuesById,
      userStatesByConversationId,
      unreadCountsByConversationId,
      pendingProposalConversationIds,
      latestReplyPreviewsByConversationId,
      userMessageSummariesByConversationId,
      sourceMetadataByConversationId,
      runtimeContinuityByConversationId,
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
        ? listPendingChatProposalConversationIds(db, orgId, conversationIds)
        : Promise.resolve(new Set<string>()),
      orgId
        ? listLatestReplyPreviews(orgId, conversationIds)
        : Promise.resolve(new Map<string, string | null>()),
      orgId
        ? listUserMessageSummaries(orgId, conversationIds)
        : Promise.resolve(new Map<string, { count: number; latestPreview: string | null }>()),
      orgId
        ? listConversationSourceMetadata(orgId, sourceLookupConversationIds)
        : Promise.resolve(new Map<string, ConversationSourceMetadata>()),
      orgId
        ? listRuntimeContinuityByConversationId(db, orgId, conversationIds)
        : Promise.resolve(new Map<string, ChatRuntimeContinuity>()),
    ]);
    return rows.map((row) => {
      const sourceMetadata = sourceMetadataByConversationId.get(row.id) ?? null;
      const isExternalBound = Boolean(sourceMetadata);
      const unreadCount = isExternalBound ? 0 : (unreadCountsByConversationId.get(row.id) ?? 0);
      const shortRef = chatShortRef(row.id);
      return {
        ...row,
        ...(shortRef ? { shortRef } : {}),
        primaryIssue: row.primaryIssueId ? (primaryIssuesById.get(row.primaryIssueId) ?? null) : null,
        latestReplyPreview: latestReplyPreviewsByConversationId.get(row.id) ?? null,
        latestUserMessagePreview: userMessageSummariesByConversationId.get(row.id)?.latestPreview ?? null,
        userMessageCount: userMessageSummariesByConversationId.get(row.id)?.count ?? 0,
        contextLinks: contextLinksByConversationId.get(row.id) ?? [],
        sourceMetadata,
        runtimeContinuity: runtimeContinuityByConversationId.get(row.id) ?? "legacy",
        mutability: conversationMutability(row, sourceMetadata, sourceMetadataByConversationId),
        lastReadAt: userStatesByConversationId.get(row.id)?.lastReadAt ?? null,
        isPinned: Boolean(userStatesByConversationId.get(row.id)?.pinnedAt),
        unreadCount,
        isUnread: unreadCount > 0,
        needsAttention: !isExternalBound && (
          unreadCount > 0 ||
          pendingProposalConversationIds.has(row.id)
        ),
      };
    });
  }

  async function hydrateConversationSummaries(rows: ConversationRow[], userId?: string | null) {
    if (userId) {
      await ensureConversationUserStates(rows, userId);
    }

    const conversationIds = rows.map((row) => row.id);
    const sourceLookupConversationIds = [
      ...new Set([
        ...conversationIds,
        ...rows.flatMap((row) => [row.forkedFromConversationId, row.forkRootConversationId].filter((id): id is string => Boolean(id))),
      ]),
    ];
    const orgId = rows[0]?.orgId ?? null;

    const [
      userStatesByConversationId,
      unreadCountsByConversationId,
      pendingProposalConversationIds,
      activeGenerationIdsByConversationId,
      latestReplyPreviewsByConversationId,
      userMessageSummariesByConversationId,
      sourceMetadataByConversationId,
      runtimeContinuityByConversationId,
    ] = await Promise.all([
      userId && orgId
        ? listConversationUserStates(orgId, userId, conversationIds)
        : Promise.resolve(new Map<string, ConversationUserStateRow>()),
      userId && orgId
        ? listUnreadCountsByConversation(orgId, userId, conversationIds)
        : Promise.resolve(new Map<string, number>()),
      orgId
        ? listPendingChatProposalConversationIds(db, orgId, conversationIds)
        : Promise.resolve(new Set<string>()),
      orgId
        ? listActiveChatGenerationIds(db, orgId, conversationIds)
        : Promise.resolve(new Map<string, string>()),
      orgId
        ? listLatestReplyPreviews(orgId, conversationIds)
        : Promise.resolve(new Map<string, string | null>()),
      orgId
        ? listUserMessageSummaries(orgId, conversationIds)
        : Promise.resolve(new Map<string, { count: number; latestPreview: string | null }>()),
      orgId
        ? listConversationSourceMetadata(orgId, sourceLookupConversationIds)
        : Promise.resolve(new Map<string, ConversationSourceMetadata>()),
      orgId
        ? listRuntimeContinuityByConversationId(db, orgId, conversationIds)
        : Promise.resolve(new Map<string, ChatRuntimeContinuity>()),
    ]);
    return rows.map((row) => {
      const sourceMetadata = sourceMetadataByConversationId.get(row.id) ?? null;
      const isExternalBound = Boolean(sourceMetadata);
      const unreadCount = isExternalBound ? 0 : (unreadCountsByConversationId.get(row.id) ?? 0);
      const shortRef = chatShortRef(row.id);
      return {
        ...row,
        ...(shortRef ? { shortRef } : {}),
        latestReplyPreview: latestReplyPreviewsByConversationId.get(row.id) ?? null,
        latestUserMessagePreview: userMessageSummariesByConversationId.get(row.id)?.latestPreview ?? null,
        userMessageCount: userMessageSummariesByConversationId.get(row.id)?.count ?? 0,
        sourceMetadata,
        runtimeContinuity: runtimeContinuityByConversationId.get(row.id) ?? "legacy",
        mutability: conversationMutability(row, sourceMetadata, sourceMetadataByConversationId),
        lastReadAt: userStatesByConversationId.get(row.id)?.lastReadAt ?? null,
        isPinned: Boolean(userStatesByConversationId.get(row.id)?.pinnedAt),
        unreadCount,
        isUnread: unreadCount > 0,
        needsAttention: !isExternalBound && (
          unreadCount > 0 ||
          pendingProposalConversationIds.has(row.id)
        ),
        activeGenerationId: activeGenerationIdsByConversationId.get(row.id) ?? null,
      };
    });
  }

  async function list(
    orgId: string,
    options?: {
      status?: "active" | "resolved" | "archived" | "all";
      q?: string;
      limit?: number;
      projectId?: string;
    },
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
    if (options?.projectId) {
      conditions.push(sql<boolean>`EXISTS (
        SELECT 1
        FROM ${chatContextLinks}
        WHERE ${chatContextLinks.conversationId} = ${chatConversations.id}
          AND ${chatContextLinks.orgId} = ${orgId}
          AND ${chatContextLinks.entityType} = 'project'
          AND ${chatContextLinks.entityId} = ${options.projectId}
      )`);
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
    let query = db
      .select()
      .from(chatConversations)
      .where(and(...conditions))
      .orderBy(desc(sql`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt})`))
      .$dynamic();
    if (typeof options?.limit === "number" && Number.isFinite(options.limit)) {
      query = query.limit(Math.max(1, Math.min(500, Math.floor(options.limit))));
    }
    const rows = await query;
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
    options?: {
      status?: "active" | "resolved" | "archived" | "all";
      limit?: number;
      after?: ConversationSummaryCursor | null;
      excludePinned?: boolean;
    },
    userId?: string | null,
  ) {
    const status = options?.status ?? "active";
    const conditions = [eq(chatConversations.orgId, orgId)];
    const activityAtSql =
      sql<Date>`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt})`;
    const threadKeySql = sql<string>`'chat:' || ${chatConversations.id}`;
    if (status !== "all") {
      conditions.push(eq(chatConversations.status, status));
    }
    if (options?.after) {
      const afterActivityAt = options.after.activityAt.toISOString();
      conditions.push(sql<boolean>`(
        ${activityAtSql} < ${afterActivityAt}
        OR (
          ${activityAtSql} = ${afterActivityAt}
          AND (
            ${chatConversations.title} > ${options.after.title}
            OR (
              ${chatConversations.title} = ${options.after.title}
              AND ${threadKeySql} > ${options.after.threadKey}
            )
          )
        )
      )`);
    }
    if (options?.excludePinned && userId) {
      conditions.push(sql<boolean>`NOT EXISTS (
        SELECT 1
        FROM ${chatConversationUserStates}
        WHERE ${chatConversationUserStates.orgId} = ${orgId}
          AND ${chatConversationUserStates.userId} = ${userId}
          AND ${chatConversationUserStates.conversationId} = ${chatConversations.id}
          AND ${chatConversationUserStates.pinnedAt} IS NOT NULL
      )`);
    }
    let query = db
      .select()
      .from(chatConversations)
      .where(and(...conditions))
      .orderBy(desc(activityAtSql), chatConversations.title, chatConversations.id)
      .$dynamic();
    if (typeof options?.limit === "number" && Number.isFinite(options.limit)) {
      query = query.limit(Math.max(1, Math.floor(options.limit)));
    }
    const rows = await query;
    return hydrateConversationSummaries(rows, userId);
  }

  async function listPinnedSummaries(orgId: string, userId: string) {
    const stateRows = await db
      .select({ conversationId: chatConversationUserStates.conversationId })
      .from(chatConversationUserStates)
      .where(
        and(
          eq(chatConversationUserStates.orgId, orgId),
          eq(chatConversationUserStates.userId, userId),
          sql<boolean>`${chatConversationUserStates.pinnedAt} IS NOT NULL`,
        ),
      );
    const conversationIds = stateRows.map((row) => row.conversationId);
    if (conversationIds.length === 0) return [];

    const activityAtSql = sql<Date>`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt})`;
    const rows = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.orgId, orgId),
          eq(chatConversations.status, "active"),
          inArray(chatConversations.id, conversationIds),
        ),
      )
      .orderBy(desc(activityAtSql), chatConversations.title, chatConversations.id);
    return hydrateConversationSummaries(rows, userId);
  }

  async function listSummariesByIds(orgId: string, conversationIds: string[], userId?: string | null) {
    const uniqueConversationIds = [...new Set(conversationIds.filter((id) => id.trim().length > 0))];
    if (uniqueConversationIds.length === 0) return [];

    const rows = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.orgId, orgId),
          eq(chatConversations.status, "active"),
          inArray(chatConversations.id, uniqueConversationIds),
        ),
      );
    return hydrateConversationSummaries(rows, userId);
  }

  return {
    hydrateConversations,
    list,
    listSummaries,
    listPinnedSummaries,
    listSummariesByIds,
  };
}
