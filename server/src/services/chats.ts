import type { Db } from "@rudderhq/db";
import {
  agentIntegrationChatBindings,
  agentIntegrations,
  agents,
  approvals,
  assets,
  chatAttachments,
  chatContextLinks,
  chatControlActions,
  chatConversations,
  chatConversationUserStates,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  chatQueuedMessages,
  organizations
} from "@rudderhq/db";
import { chatInlineVisualMappingsFromStructuredPayload, parseCodexInlineVisualDirectives, parseRudderInlineVisualPlacements, rudderInlineVisualMappingsFromStructuredPayload, sanitizeChatStructuredPayload, type ChatControlDisposition, type ChatInlineVisualMapping, type ChatProviderControlDisposition, type ChatQueuedMessage, type ChatQueuedMessagePayload, type ChatQueuedMessageStatus, type ChatQueueRequestActor, type ChatStreamTranscriptEntry, type RudderInlineVisualMapping } from "@rudderhq/shared";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { agentService } from "./agents.js";
import { approvalService } from "./approvals.js";
import { ensureChatFamilyGroup } from "./chat-family-groups.js";
import { chatGenerationProtocolService } from "./chat-generation-protocol.js";
import {
  ACTIVE_CHAT_GENERATION_STATUSES,
  CHAT_GENERATION_CONTROL_LEASE_MS,
  NATIVE_STEER_GENERATION_STATUSES,
  SERVER_QUEUE_RUNNING_STATUSES,
} from "./chats.constants.js";
import { createChatConversation, createChatWithInitialMessage, type CreateChatInput, type CreateChatWithInitialMessageInput } from "./chats.create.js";
import { conversationMutability, nextForkTitle } from "./chats.fork-helpers.js";
import {
  buildSearchSnippet,
  CHAT_TRANSCRIPT_KEY,
  chatTranscriptFromPayload,
  chatTranscriptSummaryFromEntries,
  contentPath,
  escapeLikePattern,
  incomingMessagePreviewSql,
  issueProposalFromPayload,
  isVisibleIncomingChatMessage,
  listContextLinksForConversationIds,
  listPrimaryIssues,
  operationProposalDecisionStatusFromPayload,
  operationProposalFromPayload,
  resolveContextEntities,
  safeTrim,
  stripChatMetadataFromPayload,
  textContains,
  truncatePreview,
  visibleIncomingMessageSql,
  withOperationProposalDecisionState,
  withPersistedTranscript,
} from "./chats.helpers.js";
import {
  copyForkInlineVisualMessages,
  listRecentUserChatMessages,
  updateTrustedInlineVisualMappings,
} from "./chats.inline-visual-persistence.js";
import type { ChatServerQueueClaim, ConversationSourceMetadata, ConversationSummaryCursor, MessageHydrationRow } from "./chats.types.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";
import { normalizeLocalLibraryPathMarkdown } from "./library-path-markdown.js";
import { organizationService } from "./orgs.js";
import { isPostgresError } from "./postgres-errors.js";

type ConversationRow = typeof chatConversations.$inferSelect;
type ConversationUserStateRow = typeof chatConversationUserStates.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;
type ChatQueuedMessageRow = typeof chatQueuedMessages.$inferSelect;
type ChatGenerationRow = typeof chatGenerations.$inferSelect;
type ChatControlActionRow = typeof chatControlActions.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

const CHAT_TITLE_MAX_LENGTH = 200;

export type { ChatServerQueueClaim } from "./chats.types.js";

export function chatService(db: Db) {
  const generationProtocol = chatGenerationProtocolService(db);
  const QUEUED_MESSAGE_CLAIM_LEASE_MS = 2 * 60 * 1000;
  const issuesSvc = issueService(db);
  const approvalsSvc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const organizationsSvc = organizationService(db);
  const agentsSvc = agentService(db);

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
      orgId
        ? listUserMessageSummaries(orgId, conversationIds)
        : Promise.resolve(new Map<string, { count: number; latestPreview: string | null }>()),
      orgId
        ? listConversationSourceMetadata(orgId, sourceLookupConversationIds)
        : Promise.resolve(new Map<string, ConversationSourceMetadata>()),
    ]);
    return rows.map((row) => {
      const sourceMetadata = sourceMetadataByConversationId.get(row.id) ?? null;
      const isExternalBound = Boolean(sourceMetadata);
      const unreadCount = isExternalBound ? 0 : (unreadCountsByConversationId.get(row.id) ?? 0);
      return {
        ...row,
        primaryIssue: row.primaryIssueId ? (primaryIssuesById.get(row.primaryIssueId) ?? null) : null,
        latestReplyPreview: latestReplyPreviewsByConversationId.get(row.id) ?? null,
        latestUserMessagePreview: userMessageSummariesByConversationId.get(row.id)?.latestPreview ?? null,
        userMessageCount: userMessageSummariesByConversationId.get(row.id)?.count ?? 0,
        contextLinks: contextLinksByConversationId.get(row.id) ?? [],
        sourceMetadata,
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
      latestReplyPreviewsByConversationId,
      userMessageSummariesByConversationId,
      sourceMetadataByConversationId,
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
      orgId
        ? listUserMessageSummaries(orgId, conversationIds)
        : Promise.resolve(new Map<string, { count: number; latestPreview: string | null }>()),
      orgId
        ? listConversationSourceMetadata(orgId, sourceLookupConversationIds)
        : Promise.resolve(new Map<string, ConversationSourceMetadata>()),
    ]);
    return rows.map((row) => {
      const sourceMetadata = sourceMetadataByConversationId.get(row.id) ?? null;
      const isExternalBound = Boolean(sourceMetadata);
      const unreadCount = isExternalBound ? 0 : (unreadCountsByConversationId.get(row.id) ?? 0);
      return {
        ...row,
        latestReplyPreview: latestReplyPreviewsByConversationId.get(row.id) ?? null,
        latestUserMessagePreview: userMessageSummariesByConversationId.get(row.id)?.latestPreview ?? null,
        userMessageCount: userMessageSummariesByConversationId.get(row.id)?.count ?? 0,
        sourceMetadata,
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
      const safeRow = row.contentType === "text/html" && row.createdByAgentId
        ? (({ provider: _provider, objectKey: _objectKey, ...safe }) => safe)(row)
        : row;
      const attachment = {
        ...safeRow,
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

  function isQueuePositionConflict(error: unknown): boolean {
    return isPostgresError(error, "23505");
  }

  function normalizeQueuedPayload(payload: Record<string, unknown>): ChatQueuedMessagePayload {
    return {
      body: String(payload.body ?? ""),
      attachmentIds: Array.isArray(payload.attachmentIds)
        ? payload.attachmentIds.filter((id): id is string => typeof id === "string")
        : [],
      projectId: typeof payload.projectId === "string" ? payload.projectId : null,
      skillRefs: Array.isArray(payload.skillRefs)
        ? payload.skillRefs.filter((ref): ref is string => typeof ref === "string")
        : [],
      accessMode: typeof payload.accessMode === "string" ? payload.accessMode : null,
      model: typeof payload.model === "string" ? payload.model : null,
      effort: typeof payload.effort === "string" ? payload.effort : null,
      metadata:
        payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
          ? payload.metadata as Record<string, unknown>
          : null,
    };
  }

  function hydrateQueuedMessage(row: ChatQueuedMessageRow): ChatQueuedMessage {
    return {
      ...row,
      payload: normalizeQueuedPayload(row.payload),
    };
  }

  async function createGeneration(orgId: string, conversationId: string): Promise<ChatGenerationRow> {
    const now = new Date();
    const [row] = await db
      .insert(chatGenerations)
      .values({
        orgId,
        conversationId,
        status: "active",
        controlOwnerToken: randomUUID(),
        controlLeaseExpiresAt: new Date(now.getTime() + CHAT_GENERATION_CONTROL_LEASE_MS),
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Failed to create chat generation");
    return row;
  }

  async function markGenerationTerminal(
    generationId: string | null | undefined,
    status: "completed" | "failed" | "stopped" | "aborted",
  ) {
    if (!generationId) return null;
    const now = new Date();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(chatGenerations)
        .set({
          status,
          terminalReason: status,
          controlState: "terminal",
          runtimeTerminalAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatGenerations.id, generationId),
            inArray(chatGenerations.status, ACTIVE_CHAT_GENERATION_STATUSES),
          ),
        )
        .returning();
      if (!row) return null;

      const deliveredSteers = await tx
        .update(chatQueuedMessages)
        .set({
          status: "delivered",
          deliveryDisposition: "delivered",
          reconciliationReason: null,
          lastDeliveryReason: null,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatQueuedMessages.status, "accepted_current"),
            or(
              eq(chatQueuedMessages.expectedGenerationId, generationId),
              eq(chatQueuedMessages.activeGenerationId, generationId),
            ),
          ),
        )
        .returning({ controlActionId: chatQueuedMessages.controlActionId });
      const controlActionIds = deliveredSteers
        .map((item) => item.controlActionId)
        .filter((id): id is string => Boolean(id));
      if (controlActionIds.length > 0) {
        await tx
          .update(chatControlActions)
          .set({
            localDisposition: "delivered",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              inArray(chatControlActions.id, controlActionIds),
              eq(chatControlActions.localDisposition, "accepted_current"),
            ),
          );
      }

      const continuedSteers = await tx
        .update(chatQueuedMessages)
        .set({
          status: "continuation_pending",
          deliveryDisposition: "continuation_pending",
          reconciliationReason: `target_generation_${status}`,
          lastDeliveryReason: null,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatQueuedMessages.status, "steer_pending"),
            or(
              eq(chatQueuedMessages.expectedGenerationId, generationId),
              eq(chatQueuedMessages.activeGenerationId, generationId),
            ),
          ),
        )
        .returning({ controlActionId: chatQueuedMessages.controlActionId });
      const continuedControlActionIds = continuedSteers
        .map((item) => item.controlActionId)
        .filter((id): id is string => Boolean(id));
      if (continuedControlActionIds.length > 0) {
        await tx
          .update(chatControlActions)
          .set({
            localDisposition: "continuation_pending",
            providerDisposition: "not_sent",
            lastError: `target_generation_${status}`,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              inArray(chatControlActions.id, continuedControlActionIds),
              eq(chatControlActions.localDisposition, "pending"),
            ),
          );
      }
      return row;
    });
  }

  async function getLatestActiveGeneration(conversationId: string) {
    return db
      .select()
      .from(chatGenerations)
      .where(
        and(
          eq(chatGenerations.conversationId, conversationId),
          inArray(chatGenerations.status, ACTIVE_CHAT_GENERATION_STATUSES),
        ),
      )
      .orderBy(desc(chatGenerations.startedAt), desc(chatGenerations.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestGeneration(conversationId: string) {
    return db
      .select()
      .from(chatGenerations)
      .where(eq(chatGenerations.conversationId, conversationId))
      .orderBy(desc(chatGenerations.startedAt), desc(chatGenerations.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function listQueuedMessages(conversationId: string) {
    await reclaimStaleQueuedMessageClaims(conversationId);
    const rows = await db
      .select()
      .from(chatQueuedMessages)
      .where(
        and(
          eq(chatQueuedMessages.conversationId, conversationId),
          isNull(chatQueuedMessages.cancelledAt),
          inArray(chatQueuedMessages.status, [
            "queued",
            "steer_pending",
            "acceptance_unknown",
            "continuation_pending",
            "dequeue_claimed",
            "running",
            "running_next",
            "failed_actionable",
          ]),
        ),
      )
      .orderBy(asc(chatQueuedMessages.position), asc(chatQueuedMessages.createdAt));
    return rows.map(hydrateQueuedMessage);
  }

  async function getQueueSnapshot(conversationId: string, activeGenerationId?: string | null) {
    const activeGeneration = activeGenerationId === undefined
      ? await getLatestActiveGeneration(conversationId)
      : activeGenerationId
        ? await db
          .select()
          .from(chatGenerations)
          .where(
            and(
              eq(chatGenerations.id, activeGenerationId),
              eq(chatGenerations.conversationId, conversationId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
        : null;
    return {
      activeGenerationId: activeGeneration?.id ?? null,
      activeAttemptEpoch: activeGeneration?.attemptEpoch ?? null,
      activeControlVersion: activeGeneration?.controlVersion ?? null,
      activeGenerationStatus: activeGeneration?.status ?? null,
      items: await listQueuedMessages(conversationId),
    };
  }

  async function beginGenerationControlAttempt(input: {
    orgId: string;
    conversationId: string;
    generationId: string;
    attemptEpoch: number;
    ownerToken: string;
    runtimeType: string;
  }) {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + CHAT_GENERATION_CONTROL_LEASE_MS);
    const [row] = await db
      .update(chatGenerations)
      .set({
        attemptEpoch: input.attemptEpoch,
        controlState: "unregistered",
        controlRuntimeType: input.runtimeType,
        controlOwnerToken: input.ownerToken,
        controlLeaseExpiresAt: leaseExpiresAt,
        providerThreadId: null,
        providerTurnId: null,
        status: "starting",
        updatedAt: now,
      })
      .where(
        and(
          eq(chatGenerations.id, input.generationId),
          eq(chatGenerations.orgId, input.orgId),
          eq(chatGenerations.conversationId, input.conversationId),
          isNull(chatGenerations.runtimeTerminalAt),
          inArray(chatGenerations.status, ["active", "starting", "running", "tool_busy", "closing"]),
          sql`${chatGenerations.attemptEpoch} <= ${input.attemptEpoch}`,
        ),
      )
      .returning();
    if (!row) throw conflict("Chat generation control ownership changed before runtime startup");
    return row;
  }

  async function markGenerationControlReady(input: {
    generationId: string;
    attemptEpoch: number;
    ownerToken: string;
    runtimeType: string;
    providerThreadId?: string | null;
    providerTurnId?: string | null;
  }) {
    const now = new Date();
    const [row] = await db
      .update(chatGenerations)
      .set({
        controlState: "ready",
        controlRuntimeType: input.runtimeType,
        providerThreadId: input.providerThreadId ?? null,
        providerTurnId: input.providerTurnId ?? null,
        controlLeaseExpiresAt: new Date(now.getTime() + CHAT_GENERATION_CONTROL_LEASE_MS),
        status: "running",
        updatedAt: now,
      })
      .where(
        and(
          eq(chatGenerations.id, input.generationId),
          eq(chatGenerations.attemptEpoch, input.attemptEpoch),
          eq(chatGenerations.controlOwnerToken, input.ownerToken),
          isNull(chatGenerations.runtimeTerminalAt),
          inArray(chatGenerations.status, ["active", "starting", "running", "tool_busy"]),
        ),
      )
      .returning();
    if (!row) throw conflict("Chat runtime control handle lost its generation lease");
    return row;
  }

  async function renewGenerationControlLease(input: {
    generationId: string;
    attemptEpoch: number;
    ownerToken: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const [row] = await db
      .update(chatGenerations)
      .set({
        controlLeaseExpiresAt: new Date(now.getTime() + CHAT_GENERATION_CONTROL_LEASE_MS),
        updatedAt: now,
      })
      .where(and(
        eq(chatGenerations.id, input.generationId),
        eq(chatGenerations.attemptEpoch, input.attemptEpoch),
        eq(chatGenerations.controlOwnerToken, input.ownerToken),
        isNull(chatGenerations.runtimeTerminalAt),
        inArray(chatGenerations.status, ["active", "starting", "running", "tool_busy", "closing"]),
      ))
      .returning({ id: chatGenerations.id });
    if (!row) throw conflict("Chat generation control lease is no longer current");
    return true;
  }

  async function markGenerationControlAttemptCompleted(input: {
    generationId: string;
    attemptEpoch: number;
    ownerToken: string;
  }) {
    const now = new Date();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(chatGenerations)
        .set({
          controlState: "unregistered",
          status: "closing",
          updatedAt: now,
        })
        .where(
          and(
            eq(chatGenerations.id, input.generationId),
            eq(chatGenerations.attemptEpoch, input.attemptEpoch),
            eq(chatGenerations.controlOwnerToken, input.ownerToken),
            inArray(chatGenerations.status, ["active", "starting", "running", "tool_busy", "closing"]),
          ),
        )
        .returning();
      if (!row) return null;

      const pendingSteers = await tx
        .select({
          id: chatQueuedMessages.id,
          controlActionId: chatQueuedMessages.controlActionId,
        })
        .from(chatQueuedMessages)
        .where(
          and(
            eq(chatQueuedMessages.status, "steer_pending"),
            eq(chatQueuedMessages.activeGenerationId, input.generationId),
            eq(chatQueuedMessages.attemptEpoch, input.attemptEpoch),
          ),
        );
      const pendingItemIds = pendingSteers.map((item) => item.id).sort();
      const controlActionIds = pendingSteers
        .map((item) => item.controlActionId)
        .filter((id): id is string => Boolean(id))
        .sort();
      if (controlActionIds.length > 0) {
        await tx
          .select({ id: chatControlActions.id })
          .from(chatControlActions)
          .where(inArray(chatControlActions.id, controlActionIds))
          .orderBy(asc(chatControlActions.id))
          .for("update");
      }
      if (pendingItemIds.length > 0) {
        await tx
          .select({ id: chatQueuedMessages.id })
          .from(chatQueuedMessages)
          .where(inArray(chatQueuedMessages.id, pendingItemIds))
          .orderBy(asc(chatQueuedMessages.id))
          .for("update");
      }

      const uncertainSteers = pendingItemIds.length === 0
        ? []
        : await tx
          .update(chatQueuedMessages)
          .set({
            status: "acceptance_unknown",
            deliveryDisposition: "acceptance_unknown",
            reconciliationReason: "runtime_attempt_completed_after_steer_send",
            lastDeliveryReason: "runtime_attempt_completed_after_steer_send",
            version: sql`${chatQueuedMessages.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              inArray(chatQueuedMessages.id, pendingItemIds),
              eq(chatQueuedMessages.status, "steer_pending"),
              inArray(
                chatQueuedMessages.controlActionId,
                tx
                  .select({ id: chatControlActions.id })
                  .from(chatControlActions)
                  .where(inArray(chatControlActions.providerDisposition, [
                    "sent",
                    "timed_out",
                    "connection_lost",
                    "waiting_safe_boundary",
                    "unverified",
                  ])),
              ),
            ),
          )
          .returning({ controlActionId: chatQueuedMessages.controlActionId });
      const uncertainControlActionIds = uncertainSteers
        .map((item) => item.controlActionId)
        .filter((id): id is string => Boolean(id));
      if (uncertainControlActionIds.length > 0) {
        await tx
          .update(chatControlActions)
          .set({
            localDisposition: "acceptance_unknown",
            providerDisposition: "unverified",
            lastError: "runtime_attempt_completed_after_steer_send",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            inArray(chatControlActions.id, uncertainControlActionIds),
            eq(chatControlActions.localDisposition, "pending"),
          ));
      }

      const continuedSteers = pendingItemIds.length === 0
        ? []
        : await tx
        .update(chatQueuedMessages)
        .set({
          status: "continuation_pending",
          deliveryDisposition: "continuation_pending",
          reconciliationReason: "runtime_attempt_completed_without_steer_acceptance",
          lastDeliveryReason: null,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            inArray(chatQueuedMessages.id, pendingItemIds),
            eq(chatQueuedMessages.status, "steer_pending"),
            or(
              isNull(chatQueuedMessages.controlActionId),
              inArray(
                chatQueuedMessages.controlActionId,
                tx
                  .select({ id: chatControlActions.id })
                  .from(chatControlActions)
                  .where(or(
                    eq(chatControlActions.providerDisposition, "not_sent"),
                    eq(chatControlActions.providerDisposition, "rejected"),
                    isNull(chatControlActions.providerDisposition),
                  )),
              ),
            ),
          ),
        )
        .returning({ controlActionId: chatQueuedMessages.controlActionId });
      const continuedControlActionIds = continuedSteers
        .map((item) => item.controlActionId)
        .filter((id): id is string => Boolean(id));
      if (continuedControlActionIds.length > 0) {
        await tx
          .update(chatControlActions)
          .set({
            localDisposition: "continuation_pending",
            providerDisposition: "not_sent",
            lastError: "runtime_attempt_completed_without_steer_acceptance",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              inArray(chatControlActions.id, continuedControlActionIds),
              eq(chatControlActions.localDisposition, "pending"),
            ),
          );
      }
      return row;
    });
  }

  async function appendGenerationEvent(input: {
    orgId: string;
    generationId: string;
    attemptEpoch: number;
    eventKind: typeof chatGenerationEvents.$inferInsert.eventKind;
    payload?: Record<string, unknown>;
    controlActionId?: string | null;
    queueItemId?: string | null;
    emittedAt?: Date | null;
  }) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from ${chatGenerations} where ${chatGenerations.id} = ${input.generationId} and ${chatGenerations.orgId} = ${input.orgId} for update`,
      );
      const generation = await tx
        .select({ id: chatGenerations.id })
        .from(chatGenerations)
        .where(and(eq(chatGenerations.id, input.generationId), eq(chatGenerations.orgId, input.orgId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!generation) throw notFound("Chat generation not found");
      const nextSeq = await tx
        .select({ value: sql<number>`coalesce(max(${chatGenerationEvents.generationSeq}), 0) + 1` })
        .from(chatGenerationEvents)
        .where(eq(chatGenerationEvents.generationId, input.generationId))
        .then((rows) => Number(rows[0]?.value ?? 1));
      const [event] = await tx
        .insert(chatGenerationEvents)
        .values({
          orgId: input.orgId,
          generationId: input.generationId,
          generationSeq: nextSeq,
          attemptEpoch: input.attemptEpoch,
          eventKind: input.eventKind,
          payload: input.payload ?? {},
          controlActionId: input.controlActionId ?? null,
          queueItemId: input.queueItemId ?? null,
          emittedAt: input.emittedAt ?? null,
        })
        .returning();
      if (!event) throw new Error("Failed to append chat generation event");
      return event;
    });
  }

  async function beginSteerControlAction(input: {
    orgId: string;
    conversationId: string;
    itemId: string;
    controlActionId: string;
    expectedGenerationId: string;
    expectedAttemptEpoch: number;
    expectedControlVersion: number;
    requestActor?: ChatQueueRequestActor | null;
  }): Promise<{
    action: ChatControlActionRow;
    item: ReturnType<typeof hydrateQueuedMessage>;
    generation: ChatGenerationRow | null;
    idempotent: boolean;
  }> {
    return db.transaction(async (tx) => {
      const existingAction = await tx
        .select()
        .from(chatControlActions)
        .where(
          and(
            eq(chatControlActions.id, input.controlActionId),
            eq(chatControlActions.orgId, input.orgId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingAction) {
        const existingItem = await tx
          .select()
          .from(chatQueuedMessages)
          .where(
            and(
              eq(chatQueuedMessages.id, input.itemId),
              eq(chatQueuedMessages.conversationId, input.conversationId),
              eq(chatQueuedMessages.controlActionId, existingAction.id),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const existingGeneration = existingAction.expectedGenerationId
          ? await tx
            .select()
            .from(chatGenerations)
            .where(eq(chatGenerations.id, existingAction.expectedGenerationId))
            .limit(1)
            .then((rows) => rows[0] ?? null)
          : null;
        if (!existingItem || existingAction.actionKind !== "steer") {
          throw conflict("Control action id was already used for a different operation");
        }
        return {
          action: existingAction,
          item: hydrateQueuedMessage(existingItem),
          generation: existingGeneration,
          idempotent: true,
        };
      }

      await tx.execute(
        sql`select id from ${chatGenerations} where ${chatGenerations.id} = ${input.expectedGenerationId} for update`,
      );
      await tx.execute(
        sql`select id from ${chatQueuedMessages} where ${chatQueuedMessages.id} = ${input.itemId} for update`,
      );
      const generation = await tx
        .select()
        .from(chatGenerations)
        .where(
          and(
            eq(chatGenerations.id, input.expectedGenerationId),
            eq(chatGenerations.orgId, input.orgId),
            eq(chatGenerations.conversationId, input.conversationId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const generationAcceptsNativeSteer = Boolean(
        generation && NATIVE_STEER_GENERATION_STATUSES.includes(
          generation.status as (typeof NATIVE_STEER_GENERATION_STATUSES)[number],
        ),
      );
      const item = await tx
        .select()
        .from(chatQueuedMessages)
        .where(
          and(
            eq(chatQueuedMessages.id, input.itemId),
            eq(chatQueuedMessages.orgId, input.orgId),
            eq(chatQueuedMessages.conversationId, input.conversationId),
            inArray(chatQueuedMessages.status, ["queued", "steer_pending"]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!item) throw conflict("Queued feedback is no longer steerable");

      if (item.status === "steer_pending") {
        const boundAction = item.controlActionId
          ? await tx
            .select()
            .from(chatControlActions)
            .where(and(
              eq(chatControlActions.id, item.controlActionId),
              eq(chatControlActions.orgId, input.orgId),
              eq(chatControlActions.actionKind, "steer"),
            ))
            .limit(1)
            .then((rows) => rows[0] ?? null)
          : null;
        if (!boundAction) {
          throw conflict("Queued feedback has an unresolved Steer action");
        }
        const boundGeneration = boundAction.expectedGenerationId
          ? await tx
            .select()
            .from(chatGenerations)
            .where(and(
              eq(chatGenerations.id, boundAction.expectedGenerationId),
              eq(chatGenerations.orgId, input.orgId),
              eq(chatGenerations.conversationId, input.conversationId),
            ))
            .limit(1)
            .then((rows) => rows[0] ?? null)
          : null;
        return {
          action: boundAction,
          item: hydrateQueuedMessage(item),
          generation: boundGeneration,
          idempotent: true,
        };
      }

      if (generationAcceptsNativeSteer && generation && (
        generation.attemptEpoch !== input.expectedAttemptEpoch
        || generation.controlVersion !== input.expectedControlVersion
      )) {
        throw conflict("The targeted chat generation control version changed");
      }

      const now = new Date();
      if (!generationAcceptsNativeSteer) {
        const [action] = await tx
          .insert(chatControlActions)
          .values({
            id: input.controlActionId,
            orgId: input.orgId,
            expectedGenerationId: generation?.id ?? null,
            expectedAttemptEpoch: generation?.attemptEpoch ?? null,
            expectedControlVersion: generation?.controlVersion ?? null,
            actionKind: "steer",
            localDisposition: "continuation_pending",
            providerDisposition: "not_sent",
            providerClientMessageId: input.controlActionId,
            resolvedAt: now,
          })
          .returning();
        if (!action) throw new Error("Failed to persist Steer continuation action");
        const [updatedItem] = await tx
          .update(chatQueuedMessages)
          .set({
            status: "continuation_pending",
            deliveryIntent: "steer",
            deliveryDisposition: "continuation_pending",
            controlActionId: action.id,
            requestActor: item.requestActor ?? input.requestActor ?? null,
            activeGenerationId: generation?.id ?? item.activeGenerationId,
            attemptEpoch: generation?.attemptEpoch ?? item.attemptEpoch,
            providerClientMessageId: action.providerClientMessageId,
            reconciliationReason: generation ? "target_generation_terminal" : "target_generation_missing",
            lastDeliveryReason: null,
            version: sql`${chatQueuedMessages.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(chatQueuedMessages.id, item.id),
              eq(chatQueuedMessages.version, item.version),
            ),
          )
          .returning();
        if (!updatedItem) throw conflict("Queued feedback changed while continuation was being scheduled");
        return {
          action,
          item: hydrateQueuedMessage(updatedItem),
          generation,
          idempotent: false,
        };
      }

      if (!generation) throw new Error("Expected a native Steer generation");
      const appliedControlVersion = generation.controlVersion + 1;
      const [action] = await tx
        .insert(chatControlActions)
        .values({
          id: input.controlActionId,
          orgId: input.orgId,
          expectedGenerationId: generation.id,
          expectedAttemptEpoch: generation.attemptEpoch,
          expectedControlVersion: generation.controlVersion,
          appliedControlVersion,
          actionKind: "steer",
          localDisposition: "pending",
          providerDisposition: "not_sent",
          controlOwnerToken: generation.controlOwnerToken,
          providerClientMessageId: input.controlActionId,
        })
        .returning();
      if (!action) throw new Error("Failed to create chat Steer control action");
      const [updatedGeneration] = await tx
        .update(chatGenerations)
        .set({ controlVersion: appliedControlVersion, updatedAt: now })
        .where(
          and(
            eq(chatGenerations.id, generation.id),
            eq(chatGenerations.controlVersion, generation.controlVersion),
            eq(chatGenerations.attemptEpoch, generation.attemptEpoch),
          ),
        )
        .returning();
      if (!updatedGeneration) throw conflict("The targeted chat generation control version changed");
      const [updatedItem] = await tx
        .update(chatQueuedMessages)
        .set({
          status: "steer_pending",
          deliveryIntent: "steer",
          deliveryDisposition: "pending",
          controlActionId: action.id,
          requestActor: item.requestActor ?? input.requestActor ?? null,
          activeGenerationId: generation.id,
          attemptEpoch: generation.attemptEpoch,
          providerClientMessageId: action.providerClientMessageId,
          deliveryAttempts: sql`${chatQueuedMessages.deliveryAttempts} + 1`,
          lastAttemptAt: now,
          lastDeliveryReason: null,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatQueuedMessages.id, item.id),
            eq(chatQueuedMessages.version, item.version),
          ),
        )
        .returning();
      if (!updatedItem) throw conflict("Queued feedback changed while Steer was being accepted");
      return {
        action,
        item: hydrateQueuedMessage(updatedItem),
        generation: updatedGeneration,
        idempotent: false,
      };
    });
  }

  async function resolveSteerControlAction(input: {
    orgId: string;
    conversationId: string;
    itemId: string;
    controlActionId: string;
    status: Extract<ChatQueuedMessageStatus,
      "steer_pending" | "accepted_current" | "acceptance_unknown" | "continuation_pending" | "failed_actionable">;
    disposition: Extract<ChatControlDisposition,
      "pending" | "accepted_current" | "acceptance_unknown" | "continuation_pending" | "failed_actionable">;
    providerDisposition: ChatProviderControlDisposition;
    providerThreadId?: string | null;
    providerTurnId?: string | null;
    providerEvidence?: Record<string, unknown> | null;
    reason?: string | null;
  }) {
    const now = new Date();
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${chatControlActions.id}
        from ${chatControlActions}
        where ${chatControlActions.id} = ${input.controlActionId}
          and ${chatControlActions.orgId} = ${input.orgId}
        for update
      `);
      await tx.execute(sql`
        select ${chatQueuedMessages.id}
        from ${chatQueuedMessages}
        where ${chatQueuedMessages.id} = ${input.itemId}
          and ${chatQueuedMessages.orgId} = ${input.orgId}
          and ${chatQueuedMessages.conversationId} = ${input.conversationId}
        for update
      `);
      const existingAction = await tx
        .select()
        .from(chatControlActions)
        .where(and(
          eq(chatControlActions.id, input.controlActionId),
          eq(chatControlActions.orgId, input.orgId),
          eq(chatControlActions.actionKind, "steer"),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const existingItem = await tx
        .select()
        .from(chatQueuedMessages)
        .where(and(
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.orgId, input.orgId),
          eq(chatQueuedMessages.conversationId, input.conversationId),
          eq(chatQueuedMessages.controlActionId, input.controlActionId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!existingAction) throw notFound("Chat Steer control action not found");
      if (!existingItem) throw notFound("Queued Steer feedback not found");

      const allowedCurrentStatuses: ChatQueuedMessageStatus[] = input.status === "accepted_current"
        ? ["steer_pending", "acceptance_unknown", "accepted_current"]
        : input.status === "acceptance_unknown"
          ? ["steer_pending", "acceptance_unknown"]
          : input.status === "continuation_pending"
            ? ["steer_pending", "acceptance_unknown", "continuation_pending"]
            : input.status === "steer_pending"
              ? ["steer_pending"]
              : ["steer_pending", "acceptance_unknown", "continuation_pending", "failed_actionable"];
      const transitionAllowed = allowedCurrentStatuses.includes(existingItem.status);
      const preserveAcknowledgement = existingAction.providerDisposition === "acknowledged"
        && input.providerDisposition !== "acknowledged";
      const providerDisposition = preserveAcknowledgement
        ? existingAction.providerDisposition
        : input.providerDisposition;

      const [action] = await tx
        .update(chatControlActions)
        .set({
          localDisposition: transitionAllowed ? input.disposition : existingAction.localDisposition,
          providerDisposition,
          providerThreadId: input.providerThreadId ?? existingAction.providerThreadId,
          providerTurnId: input.providerTurnId ?? existingAction.providerTurnId,
          providerEvidence: input.providerEvidence ?? existingAction.providerEvidence,
          lastError: transitionAllowed ? input.reason ?? null : existingAction.lastError,
          providerSentAt: providerDisposition === "not_sent"
            ? null
            : existingAction.providerSentAt ?? now,
          providerAcknowledgedAt: providerDisposition === "acknowledged"
            ? existingAction.providerAcknowledgedAt ?? now
            : existingAction.providerAcknowledgedAt,
          resolvedAt: transitionAllowed
            ? input.disposition === "pending" ? null : now
            : existingAction.resolvedAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatControlActions.id, input.controlActionId),
            eq(chatControlActions.orgId, input.orgId),
            eq(chatControlActions.actionKind, "steer"),
          ),
        )
        .returning();
      if (!action) throw notFound("Chat Steer control action not found");
      if (!transitionAllowed) {
        return { action, item: hydrateQueuedMessage(existingItem), applied: false };
      }
      const [item] = await tx
        .update(chatQueuedMessages)
        .set({
          status: input.status,
          deliveryDisposition: input.disposition,
          providerThreadId: input.providerThreadId ?? existingItem.providerThreadId,
          providerTurnId: input.providerTurnId ?? existingItem.providerTurnId,
          providerEvidence: input.providerEvidence ?? existingItem.providerEvidence,
          reconciliationReason: input.reason ?? null,
          lastDeliveryReason: input.reason ?? null,
          steeredAt: input.status === "accepted_current" ? now : existingItem.steeredAt,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(chatQueuedMessages.id, existingItem.id),
          eq(chatQueuedMessages.status, existingItem.status),
          eq(chatQueuedMessages.version, existingItem.version),
        ))
        .returning();
      if (!item) throw conflict("Queued Steer feedback changed while provider evidence was resolving");
      const linkedSteerMessageId = item.continuationMessageId ?? item.sourceMessageId;
      if (linkedSteerMessageId) {
        const linkedSteerMessage = await tx
          .select({ structuredPayload: chatMessages.structuredPayload })
          .from(chatMessages)
          .where(and(
            eq(chatMessages.id, linkedSteerMessageId),
            eq(chatMessages.orgId, input.orgId),
            eq(chatMessages.conversationId, input.conversationId),
            eq(chatMessages.role, "user"),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const steerPayload = linkedSteerMessage?.structuredPayload;
        if (steerPayload && steerPayload.source === "steer") {
          await tx
            .update(chatMessages)
            .set({
              structuredPayload: {
                ...steerPayload,
                deliveryDisposition: input.disposition,
              },
              updatedAt: now,
            })
            .where(eq(chatMessages.id, linkedSteerMessageId));
        }
      }
      return { action, item: hydrateQueuedMessage(item), applied: true };
    });
  }

  async function claimSteerProviderSend(input: {
    orgId: string;
    controlActionId: string;
  }) {
    return db.transaction(async (tx) => {
      const existingAction = await tx
        .select()
        .from(chatControlActions)
        .where(and(
          eq(chatControlActions.id, input.controlActionId),
          eq(chatControlActions.orgId, input.orgId),
          eq(chatControlActions.actionKind, "steer"),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !existingAction
        || existingAction.localDisposition !== "pending"
        || existingAction.providerDisposition !== "not_sent"
      ) {
        return null;
      }

      const generation = existingAction.expectedGenerationId
        ? await tx
          .select()
          .from(chatGenerations)
          .where(and(
            eq(chatGenerations.id, existingAction.expectedGenerationId),
            eq(chatGenerations.orgId, input.orgId),
          ))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null)
        : null;

      const leaseIsCurrent = generation
        ? await tx
          .select({
            value: sql<boolean>`${chatGenerations.controlLeaseExpiresAt} > clock_timestamp()`,
          })
          .from(chatGenerations)
          .where(eq(chatGenerations.id, generation.id))
          .limit(1)
          .then((rows) => rows[0]?.value === true)
        : false;
      const now = new Date();
      const generationFenceMatches = Boolean(
        generation
        && NATIVE_STEER_GENERATION_STATUSES.includes(
          generation.status as (typeof NATIVE_STEER_GENERATION_STATUSES)[number],
        )
        && generation.controlState === "ready"
        && generation.runtimeTerminalAt === null
        && Boolean(generation.controlOwnerToken)
        && generation.attemptEpoch === existingAction.expectedAttemptEpoch
        && generation.controlVersion === existingAction.appliedControlVersion
        && generation.controlOwnerToken === existingAction.controlOwnerToken
        && leaseIsCurrent,
      );

      if (!generationFenceMatches) {
        await tx.execute(sql`
          select ${chatControlActions.id}
          from ${chatControlActions}
          where ${chatControlActions.id} = ${input.controlActionId}
            and ${chatControlActions.orgId} = ${input.orgId}
          for update
        `);
        const queueItem = await tx
          .select()
          .from(chatQueuedMessages)
          .where(and(
            eq(chatQueuedMessages.controlActionId, input.controlActionId),
            eq(chatQueuedMessages.orgId, input.orgId),
          ))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!queueItem) throw conflict("Queued Steer feedback disappeared before provider send");

        const reason = generation?.stopRequestedAt
          || generation?.status === "stop_requested"
          || generation?.status === "stopping"
          ? "stop_cutoff_won_before_provider_send"
          : "generation_fence_changed_before_provider_send";
        const [action] = await tx
          .update(chatControlActions)
          .set({
            localDisposition: "continuation_pending",
            providerDisposition: "not_sent",
            providerSentAt: null,
            lastError: reason,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(chatControlActions.id, input.controlActionId),
            eq(chatControlActions.orgId, input.orgId),
            eq(chatControlActions.actionKind, "steer"),
            eq(chatControlActions.localDisposition, "pending"),
            eq(chatControlActions.providerDisposition, "not_sent"),
          ))
          .returning();
        if (!action) return null;
        const [item] = await tx
          .update(chatQueuedMessages)
          .set({
            status: "continuation_pending",
            deliveryDisposition: "continuation_pending",
            reconciliationReason: reason,
            lastDeliveryReason: null,
            version: sql`${chatQueuedMessages.version} + 1`,
            updatedAt: now,
          })
          .where(and(
            eq(chatQueuedMessages.id, queueItem.id),
            eq(chatQueuedMessages.status, "steer_pending"),
            eq(chatQueuedMessages.version, queueItem.version),
          ))
          .returning();
        if (!item) throw conflict("Queued Steer feedback changed before provider send fallback");
        return {
          sendDenied: true as const,
          reason,
          action,
          item: hydrateQueuedMessage(item),
        };
      }

      const [action] = await tx
        .update(chatControlActions)
        .set({
          providerDisposition: "sent",
          providerSentAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(chatControlActions.id, input.controlActionId),
          eq(chatControlActions.orgId, input.orgId),
          eq(chatControlActions.actionKind, "steer"),
          eq(chatControlActions.localDisposition, "pending"),
          eq(chatControlActions.providerDisposition, "not_sent"),
          eq(chatControlActions.expectedGenerationId, generation!.id),
          eq(chatControlActions.expectedAttemptEpoch, generation!.attemptEpoch),
          eq(chatControlActions.appliedControlVersion, generation!.controlVersion),
          eq(chatControlActions.controlOwnerToken, generation!.controlOwnerToken!),
        ))
        .returning();
      return action ?? null;
    });
  }

  async function releaseSteerProviderSendClaim(input: {
    orgId: string;
    controlActionId: string;
    reason: string;
  }) {
    const now = new Date();
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${chatControlActions.id}
        from ${chatControlActions}
        where ${chatControlActions.id} = ${input.controlActionId}
          and ${chatControlActions.orgId} = ${input.orgId}
        for update
      `);
      const existingAction = await tx
        .select()
        .from(chatControlActions)
        .where(and(
          eq(chatControlActions.id, input.controlActionId),
          eq(chatControlActions.orgId, input.orgId),
          eq(chatControlActions.actionKind, "steer"),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !existingAction
        || existingAction.providerDisposition !== "sent"
        || existingAction.providerAcknowledgedAt
      ) {
        return null;
      }
      await tx.execute(sql`
        select ${chatQueuedMessages.id}
        from ${chatQueuedMessages}
        where ${chatQueuedMessages.controlActionId} = ${input.controlActionId}
        for update
      `);
      const [action] = await tx
        .update(chatControlActions)
        .set({
          localDisposition: "pending",
          providerDisposition: "not_sent",
          providerSentAt: null,
          lastError: input.reason,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(chatControlActions.id, input.controlActionId),
          eq(chatControlActions.orgId, input.orgId),
          eq(chatControlActions.actionKind, "steer"),
          eq(chatControlActions.providerDisposition, "sent"),
          isNull(chatControlActions.providerAcknowledgedAt),
        ))
        .returning();
      if (!action) return null;
      await tx
        .update(chatQueuedMessages)
        .set({
          status: "steer_pending",
          deliveryDisposition: "pending",
          reconciliationReason: input.reason,
          lastDeliveryReason: input.reason,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(chatQueuedMessages.controlActionId, input.controlActionId),
          inArray(chatQueuedMessages.status, ["steer_pending", "acceptance_unknown"]),
        ));
      return action;
    });
  }

  async function createQueuedMessage(input: {
    orgId: string;
    conversationId: string;
    clientMutationId: string;
    payload: ChatQueuedMessagePayload;
    expectedGenerationId?: string | null;
    requestActor?: ChatQueueRequestActor | null;
  }) {
    const payload = {
      ...input.payload,
      body: input.payload.body.trim(),
      attachmentIds: input.payload.attachmentIds ?? [],
      skillRefs: input.payload.skillRefs ?? [],
      projectId: input.payload.projectId ?? null,
      accessMode: input.payload.accessMode ?? null,
      model: input.payload.model ?? null,
      effort: input.payload.effort ?? null,
      metadata: input.payload.metadata ?? null,
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await db.transaction(async (tx) => {
          const existing = await tx
            .select()
            .from(chatQueuedMessages)
            .where(
              and(
                eq(chatQueuedMessages.conversationId, input.conversationId),
                eq(chatQueuedMessages.clientMutationId, input.clientMutationId),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (existing) {
            if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
              throw conflict("Queued message idempotency key reused with a different payload");
            }
            return hydrateQueuedMessage(existing);
          }

          const [positionRow] = await tx
            .select({
              nextPosition: sql<number>`coalesce(max(${chatQueuedMessages.position}), 0) + 1`,
            })
            .from(chatQueuedMessages)
            .where(eq(chatQueuedMessages.conversationId, input.conversationId));
          const [row] = await tx
            .insert(chatQueuedMessages)
            .values({
              orgId: input.orgId,
              conversationId: input.conversationId,
              clientMutationId: input.clientMutationId,
              position: Number(positionRow?.nextPosition ?? 1),
              payload,
              requestActor: input.requestActor ?? null,
              expectedGenerationId: input.expectedGenerationId ?? null,
            })
            .returning();
          if (!row) throw new Error("Failed to create queued chat message");
          return hydrateQueuedMessage(row);
        });
      } catch (error) {
        if (attempt < 2 && isQueuePositionConflict(error)) continue;
        throw error;
      }
    }
    throw new Error("Failed to create queued chat message");
  }

  async function updateQueuedMessage(input: {
    conversationId: string;
    itemId: string;
    version: number;
    payload: ChatQueuedMessagePayload;
  }) {
    const now = new Date();
    const [row] = await db
      .update(chatQueuedMessages)
      .set({
        payload: {
          ...input.payload,
          body: input.payload.body.trim(),
          attachmentIds: input.payload.attachmentIds ?? [],
          skillRefs: input.payload.skillRefs ?? [],
          projectId: input.payload.projectId ?? null,
          accessMode: input.payload.accessMode ?? null,
          model: input.payload.model ?? null,
          effort: input.payload.effort ?? null,
          metadata: input.payload.metadata ?? null,
        },
        version: input.version + 1,
        lastDeliveryReason: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatQueuedMessages.conversationId, input.conversationId),
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.version, input.version),
          eq(chatQueuedMessages.status, "queued"),
        ),
      )
      .returning();
    if (!row) throw conflict("Queued message was changed or is no longer editable");
    return hydrateQueuedMessage(row);
  }

  async function cancelQueuedMessage(input: {
    conversationId: string;
    itemId: string;
    version?: number | null;
  }) {
    const now = new Date();
    const conditions = [
      eq(chatQueuedMessages.conversationId, input.conversationId),
      eq(chatQueuedMessages.id, input.itemId),
      eq(chatQueuedMessages.status, "queued"),
    ];
    if (input.version) conditions.push(eq(chatQueuedMessages.version, input.version));
    const [row] = await db
      .update(chatQueuedMessages)
      .set({
        status: "cancelled",
        version: sql`${chatQueuedMessages.version} + 1`,
        cancelledAt: now,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning();
    if (!row) throw conflict("Queued message was changed or is no longer cancellable");
    return hydrateQueuedMessage(row);
  }

  async function scheduleSteerContinuation(input: {
    orgId: string;
    conversationId: string;
    itemId: string;
    controlActionId: string;
    requestActor?: ChatQueueRequestActor | null;
  }) {
    return db.transaction(async (tx) => {
      const existingAction = await tx
        .select()
        .from(chatControlActions)
        .where(and(
          eq(chatControlActions.id, input.controlActionId),
          eq(chatControlActions.orgId, input.orgId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existingAction) {
        const existingItem = await tx
          .select()
          .from(chatQueuedMessages)
          .where(and(
            eq(chatQueuedMessages.id, input.itemId),
            eq(chatQueuedMessages.orgId, input.orgId),
            eq(chatQueuedMessages.conversationId, input.conversationId),
            eq(chatQueuedMessages.controlActionId, existingAction.id),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!existingItem || existingAction.actionKind !== "steer") {
          throw conflict("Control action id was already used for a different operation");
        }
        return {
          action: existingAction,
          item: hydrateQueuedMessage(existingItem),
          idempotent: true,
        };
      }

      await tx.execute(
        sql`select id from ${chatQueuedMessages} where ${chatQueuedMessages.id} = ${input.itemId} for update`,
      );
      const item = await tx
        .select()
        .from(chatQueuedMessages)
        .where(and(
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.orgId, input.orgId),
          eq(chatQueuedMessages.conversationId, input.conversationId),
          isNull(chatQueuedMessages.cancelledAt),
          inArray(chatQueuedMessages.status, ["queued", "steer_pending", "continuation_pending"]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!item) throw conflict("Queued feedback is no longer schedulable");

      const targetGenerationId = item.expectedGenerationId ?? item.activeGenerationId;
      const targetGeneration = targetGenerationId
        ? await tx
          .select()
          .from(chatGenerations)
          .where(and(
            eq(chatGenerations.id, targetGenerationId),
            eq(chatGenerations.orgId, input.orgId),
            eq(chatGenerations.conversationId, input.conversationId),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null)
        : await tx
          .select()
          .from(chatGenerations)
          .where(and(
            eq(chatGenerations.orgId, input.orgId),
            eq(chatGenerations.conversationId, input.conversationId),
          ))
          .orderBy(desc(chatGenerations.startedAt), desc(chatGenerations.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
      const now = new Date();
      const [action] = await tx
        .insert(chatControlActions)
        .values({
          id: input.controlActionId,
          orgId: input.orgId,
          expectedGenerationId: targetGeneration?.id ?? null,
          expectedAttemptEpoch: targetGeneration?.attemptEpoch ?? null,
          expectedControlVersion: targetGeneration?.controlVersion ?? null,
          actionKind: "steer",
          localDisposition: "continuation_pending",
          providerDisposition: "not_sent",
          providerClientMessageId: input.controlActionId,
          resolvedAt: now,
        })
        .returning();
      if (!action) throw new Error("Failed to persist Steer continuation action");
      const [updatedItem] = await tx
        .update(chatQueuedMessages)
        .set({
          status: "continuation_pending",
          deliveryIntent: "steer",
          deliveryDisposition: "continuation_pending",
          controlActionId: action.id,
          requestActor: item.requestActor ?? input.requestActor ?? null,
          activeGenerationId: targetGeneration?.id ?? item.activeGenerationId,
          attemptEpoch: targetGeneration?.attemptEpoch ?? item.attemptEpoch,
          providerClientMessageId: action.providerClientMessageId,
          reconciliationReason: targetGeneration ? "target_generation_terminal" : "no_active_generation",
          lastDeliveryReason: null,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(chatQueuedMessages.id, item.id),
          eq(chatQueuedMessages.version, item.version),
          isNull(chatQueuedMessages.cancelledAt),
        ))
        .returning();
      if (!updatedItem) throw conflict("Queued feedback changed while continuation was being scheduled");
      return {
        action,
        item: hydrateQueuedMessage(updatedItem),
        idempotent: false,
      };
    });
  }

  async function markQueuedMessageSteerFallback(input: {
    conversationId: string;
    itemId: string;
    reason: "unsupported" | "stale_generation" | "closing";
    activeGenerationId?: string | null;
  }) {
    const now = new Date();
    const [row] = await db
      .update(chatQueuedMessages)
      .set({
        status: "queued",
        activeGenerationId: input.activeGenerationId ?? null,
        deliveryAttempts: sql`${chatQueuedMessages.deliveryAttempts} + 1`,
        lastAttemptAt: now,
        lastDeliveryReason: input.reason,
        version: sql`${chatQueuedMessages.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatQueuedMessages.conversationId, input.conversationId),
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.status, "queued"),
          isNull(chatQueuedMessages.cancelledAt),
        ),
      )
      .returning();
    if (!row) throw conflict("Queued message was changed or is no longer steerable");
    return hydrateQueuedMessage(row);
  }

  async function claimNextServerQueuedMessage(input: {
    workerId: string;
    leaseMs: number;
    now?: Date;
  }): Promise<ChatServerQueueClaim | null> {
    const now = input.now ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    return db.transaction(async (tx) => {
      const batchSize = 25;
      let scanOffset = 0;
      while (true) {
        const candidates = await tx
        .select()
        .from(chatQueuedMessages)
        .where(and(
          inArray(chatQueuedMessages.status, ["continuation_pending", "steer_pending", "queued"]),
          isNull(chatQueuedMessages.cancelledAt),
          sql`jsonb_typeof(${chatQueuedMessages.requestActor}) = 'object'`,
          or(
            isNull(chatQueuedMessages.deliveryLeaseExpiresAt),
            lt(chatQueuedMessages.deliveryLeaseExpiresAt, now),
          ),
          sql`(${chatQueuedMessages.status} <> 'steer_pending' or coalesce((
            select steer_action.provider_disposition
            from ${chatControlActions} as steer_action
            where steer_action.id = ${chatQueuedMessages.controlActionId}
            limit 1
          ), 'not_sent') in ('not_sent', 'rejected'))`,
        ))
        .orderBy(
          sql`case
            when ${chatQueuedMessages.status} = 'continuation_pending' then 0
            when ${chatQueuedMessages.status} = 'steer_pending' then 1
            else 2
          end`,
          asc(chatQueuedMessages.position),
          asc(chatQueuedMessages.createdAt),
        )
        .limit(batchSize)
        .offset(scanOffset)
        .for("update", { skipLocked: true });

      for (const candidate of candidates) {
        if (!candidate.requestActor || typeof candidate.requestActor !== "object" || Array.isArray(candidate.requestActor)) {
          continue;
        }
        const latestGeneration = await tx
          .select()
          .from(chatGenerations)
          .where(and(
            eq(chatGenerations.orgId, candidate.orgId),
            eq(chatGenerations.conversationId, candidate.conversationId),
          ))
          .orderBy(desc(chatGenerations.startedAt), desc(chatGenerations.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const isSteer = candidate.deliveryIntent === "steer"
          || candidate.status === "steer_pending"
          || candidate.status === "continuation_pending";
        if (
          latestGeneration
          && ACTIVE_CHAT_GENERATION_STATUSES.some((status) => status === latestGeneration.status)
        ) {
          continue;
        }
        if (
          candidate.status === "queued"
          && latestGeneration
          && latestGeneration.status !== "completed"
        ) {
          continue;
        }
        if (
          isSteer
          && latestGeneration
          && ["failed", "control_lost", "interrupted_unverified"].includes(latestGeneration.status)
        ) {
          await tx
            .update(chatQueuedMessages)
            .set({
              status: "failed_actionable",
              deliveryDisposition: "failed_actionable",
              reconciliationReason: `prior_generation_${latestGeneration.status}`,
              lastDeliveryReason: `prior_generation_${latestGeneration.status}`,
              updatedAt: now,
              version: sql`${chatQueuedMessages.version} + 1`,
            })
            .where(eq(chatQueuedMessages.id, candidate.id));
          if (candidate.controlActionId) {
            await tx
              .update(chatControlActions)
              .set({
                localDisposition: "failed_actionable",
                lastError: `prior_generation_${latestGeneration.status}`,
                resolvedAt: now,
                updatedAt: now,
              })
              .where(eq(chatControlActions.id, candidate.controlActionId));
          }
          continue;
        }

        const generationId = randomUUID();
        const leaseToken = randomUUID();
        const leaseEpoch = candidate.deliveryLeaseEpoch + 1;
        await tx.insert(chatGenerations).values({
          id: generationId,
          orgId: candidate.orgId,
          conversationId: candidate.conversationId,
          status: "active",
          attemptEpoch: 0,
          controlVersion: 0,
          controlState: "unregistered",
          controlOwnerToken: leaseToken,
          controlLeaseExpiresAt: new Date(now.getTime() + CHAT_GENERATION_CONTROL_LEASE_MS),
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        });

        let userMessageId = candidate.continuationMessageId;
        if (userMessageId) {
          const existingMessage = await tx
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(and(
              eq(chatMessages.id, userMessageId),
              eq(chatMessages.orgId, candidate.orgId),
              eq(chatMessages.conversationId, candidate.conversationId),
              eq(chatMessages.role, "user"),
            ))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!existingMessage) userMessageId = null;
        }
        if (!userMessageId) {
          userMessageId = randomUUID();
          await tx.insert(chatMessages).values({
            id: userMessageId,
            orgId: candidate.orgId,
            conversationId: candidate.conversationId,
            role: "user",
            kind: "message",
            status: "completed",
            body: normalizeQueuedPayload(candidate.payload).body,
            structuredPayload: null,
            chatTurnId: randomUUID(),
            turnVariant: 0,
            createdAt: now,
            updatedAt: now,
          });
          await tx
            .update(chatConversations)
            .set({ lastMessageAt: now, updatedAt: now })
            .where(and(
              eq(chatConversations.id, candidate.conversationId),
              eq(chatConversations.orgId, candidate.orgId),
            ));
        }

        const [claimed] = await tx
          .update(chatQueuedMessages)
          .set({
            status: isSteer ? "running_next" : "dequeue_claimed",
            deliveryDisposition: isSteer ? "running_next" : null,
            continuationGenerationId: generationId,
            continuationMessageId: userMessageId,
            sourceMessageId: userMessageId,
            deliveredMessageId: userMessageId,
            deliveryLeaseToken: leaseToken,
            deliveryLeaseEpoch: leaseEpoch,
            deliveryLeaseOwner: input.workerId,
            deliveryLeaseExpiresAt: leaseExpiresAt,
            dequeuedAt: now,
            deliveryAttempts: sql`${chatQueuedMessages.deliveryAttempts} + 1`,
            lastAttemptAt: now,
            lastDeliveryReason: null,
            reconciliationReason: "server_claimed",
            version: sql`${chatQueuedMessages.version} + 1`,
            updatedAt: now,
          })
          .where(and(
            eq(chatQueuedMessages.id, candidate.id),
            eq(chatQueuedMessages.version, candidate.version),
            isNull(chatQueuedMessages.cancelledAt),
          ))
          .returning();
        if (!claimed) throw conflict("Queued continuation changed while being claimed");
        if (candidate.controlActionId) {
          await tx
            .update(chatControlActions)
            .set({
              localDisposition: "running_next",
              resolvedAt: null,
              updatedAt: now,
            })
            .where(and(
              eq(chatControlActions.id, candidate.controlActionId),
              eq(chatControlActions.orgId, candidate.orgId),
            ));
        }
        return {
          item: hydrateQueuedMessage(claimed),
          generationId,
          userMessageId,
          leaseToken,
          leaseEpoch,
        };
      }
        if (candidates.length < batchSize) return null;
        scanOffset += candidates.length;
      }
    });
  }

  async function renewServerQueuedMessageClaim(input: {
    itemId: string;
    generationId: string;
    leaseToken: string;
    leaseEpoch: number;
    leaseMs: number;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const [row] = await db
      .update(chatQueuedMessages)
      .set({
        deliveryLeaseExpiresAt: new Date(now.getTime() + input.leaseMs),
        updatedAt: now,
      })
      .where(and(
        eq(chatQueuedMessages.id, input.itemId),
        eq(chatQueuedMessages.continuationGenerationId, input.generationId),
        eq(chatQueuedMessages.deliveryLeaseToken, input.leaseToken),
        eq(chatQueuedMessages.deliveryLeaseEpoch, input.leaseEpoch),
        isNull(chatQueuedMessages.cancelledAt),
        inArray(chatQueuedMessages.status, SERVER_QUEUE_RUNNING_STATUSES),
      ))
      .returning({ id: chatQueuedMessages.id });
    return Boolean(row);
  }

  async function completeServerQueuedMessageDelivery(input: {
    itemId: string;
    generationId: string;
    leaseToken: string;
    leaseEpoch: number;
    status: "completed" | "failed" | "stopped" | "aborted";
    reason?: string | null;
  }) {
    const now = new Date();
    return db.transaction(async (tx) => {
      const item = await tx
        .select()
        .from(chatQueuedMessages)
        .where(and(
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.continuationGenerationId, input.generationId),
          eq(chatQueuedMessages.deliveryLeaseToken, input.leaseToken),
          eq(chatQueuedMessages.deliveryLeaseEpoch, input.leaseEpoch),
          inArray(chatQueuedMessages.status, SERVER_QUEUE_RUNNING_STATUSES),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!item) return null;
      const isSteer = item.deliveryIntent === "steer" || item.status === "running_next";
      const cancelled = Boolean(item.cancelledAt);
      const succeeded = !cancelled && input.status === "completed";
      const nextStatus = cancelled
        ? "cancelled"
        : succeeded
        ? (isSteer ? "delivered" : "completed")
        : "failed_actionable";
      const nextDisposition = cancelled
        ? "cancelled"
        : succeeded
        ? (isSteer ? "delivered" : null)
        : "failed_actionable";
      const terminalReason = cancelled ? "operator_cancelled" : (input.reason ?? input.status);
      const [updated] = await tx
        .update(chatQueuedMessages)
        .set({
          status: nextStatus,
          deliveryDisposition: nextDisposition,
          deliveryLeaseToken: null,
          deliveryLeaseOwner: null,
          deliveryLeaseExpiresAt: null,
          lastDeliveryReason: succeeded ? null : terminalReason,
          reconciliationReason: succeeded ? null : terminalReason,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(chatQueuedMessages.id, item.id),
          eq(chatQueuedMessages.version, item.version),
        ))
        .returning();
      if (!updated) return null;
      if (item.controlActionId) {
        await tx
          .update(chatControlActions)
          .set({
            localDisposition: nextDisposition ?? (succeeded ? "delivered" : "failed_actionable"),
            lastError: succeeded ? null : terminalReason,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(eq(chatControlActions.id, item.controlActionId));
      }
      return hydrateQueuedMessage(updated);
    });
  }

  async function releaseServerQueuedMessageClaim(input: {
    itemId: string;
    generationId: string;
    leaseToken: string;
    leaseEpoch: number;
    reason: string;
  }) {
    const now = new Date();
    return db.transaction(async (tx) => {
      const item = await tx
        .select()
        .from(chatQueuedMessages)
        .where(and(
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.continuationGenerationId, input.generationId),
          eq(chatQueuedMessages.deliveryLeaseToken, input.leaseToken),
          eq(chatQueuedMessages.deliveryLeaseEpoch, input.leaseEpoch),
          inArray(chatQueuedMessages.status, SERVER_QUEUE_RUNNING_STATUSES),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!item) return null;
      const generation = await tx
        .select()
        .from(chatGenerations)
        .where(eq(chatGenerations.id, input.generationId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const providerMayHaveStarted = Boolean(generation && (
        generation.attemptEpoch > 0
        || generation.status === "starting"
        || generation.status === "running"
        || generation.status === "tool_busy"
        || generation.status === "closing"
      ));
      const isSteer = item.deliveryIntent === "steer" || item.status === "running_next";
      const cancelled = Boolean(item.cancelledAt);
      const nextStatus = cancelled
        ? "cancelled"
        : providerMayHaveStarted
        ? (isSteer ? "acceptance_unknown" : "failed_actionable")
        : (isSteer ? "continuation_pending" : "queued");
      const nextDisposition = cancelled
        ? "cancelled"
        : providerMayHaveStarted
        ? (isSteer ? "acceptance_unknown" : "failed_actionable")
        : (isSteer ? "continuation_pending" : null);
      const releaseReason = cancelled ? "operator_cancelled" : input.reason;
      const [updated] = await tx
        .update(chatQueuedMessages)
        .set({
          status: nextStatus,
          deliveryDisposition: nextDisposition,
          continuationGenerationId: null,
          deliveryLeaseToken: null,
          deliveryLeaseOwner: null,
          deliveryLeaseExpiresAt: null,
          lastDeliveryReason: releaseReason,
          reconciliationReason: releaseReason,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(chatQueuedMessages.id, item.id),
          eq(chatQueuedMessages.version, item.version),
        ))
        .returning();
      if (!updated) return null;
      if (generation) {
        await tx
          .update(chatGenerations)
          .set({
            status: "aborted",
            terminalReason: releaseReason,
            controlState: providerMayHaveStarted ? "control_lost" : "terminal",
            runtimeTerminalAt: now,
            completedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(chatGenerations.id, generation.id),
            inArray(chatGenerations.status, ACTIVE_CHAT_GENERATION_STATUSES),
          ));
      }
      if (item.controlActionId) {
        await tx
          .update(chatControlActions)
          .set({
            localDisposition: nextDisposition ?? "pending",
            providerDisposition: providerMayHaveStarted ? "unverified" : "not_sent",
            lastError: releaseReason,
            resolvedAt: providerMayHaveStarted ? now : null,
            updatedAt: now,
          })
          .where(eq(chatControlActions.id, item.controlActionId));
      }
      return hydrateQueuedMessage(updated);
    });
  }

  async function recoverExpiredServerQueueClaims(now = new Date()) {
    const expired = await db
      .select({
        id: chatQueuedMessages.id,
        generationId: chatQueuedMessages.continuationGenerationId,
        leaseToken: chatQueuedMessages.deliveryLeaseToken,
        leaseEpoch: chatQueuedMessages.deliveryLeaseEpoch,
      })
      .from(chatQueuedMessages)
      .where(and(
        inArray(chatQueuedMessages.status, SERVER_QUEUE_RUNNING_STATUSES),
        lt(chatQueuedMessages.deliveryLeaseExpiresAt, now),
      ));
    let requeued = 0;
    let ambiguous = 0;
    for (const row of expired) {
      if (!row.generationId || !row.leaseToken) continue;
      const recovered = await releaseServerQueuedMessageClaim({
        itemId: row.id,
        generationId: row.generationId,
        leaseToken: row.leaseToken,
        leaseEpoch: row.leaseEpoch,
        reason: "server_continuation_lease_expired",
      });
      if (!recovered) continue;
      if (recovered.status === "continuation_pending" || recovered.status === "queued") requeued += 1;
      else ambiguous += 1;
    }
    return { inspected: expired.length, requeued, ambiguous };
  }

  async function claimNextQueuedMessage(conversationId: string) {
    await reclaimStaleQueuedMessageClaims(conversationId);
    const now = new Date();
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(chatQueuedMessages)
        .where(
          and(
            eq(chatQueuedMessages.conversationId, conversationId),
            eq(chatQueuedMessages.status, "queued"),
            isNull(chatQueuedMessages.cancelledAt),
          ),
        )
        .orderBy(asc(chatQueuedMessages.position), asc(chatQueuedMessages.createdAt))
        .limit(1);
      if (!candidate) return null;
      const [row] = await tx
        .update(chatQueuedMessages)
        .set({
          status: "dequeue_claimed",
          dequeuedAt: now,
          deliveryAttempts: sql`${chatQueuedMessages.deliveryAttempts} + 1`,
          lastAttemptAt: now,
          lastDeliveryReason: null,
          version: sql`${chatQueuedMessages.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatQueuedMessages.id, candidate.id),
            eq(chatQueuedMessages.conversationId, conversationId),
            eq(chatQueuedMessages.status, "queued"),
            eq(chatQueuedMessages.version, candidate.version),
            isNull(chatQueuedMessages.cancelledAt),
          ),
        )
        .returning();
      return row ? hydrateQueuedMessage(row) : null;
    });
  }

  async function releaseQueuedMessageClaim(input: {
    conversationId: string;
    itemId: string;
    reason: "delivery_failed" | "delivery_aborted" | "claim_expired";
  }) {
    const now = new Date();
    const [cancelledRow] = await db
      .update(chatQueuedMessages)
      .set({
        status: "cancelled",
        deliveryDisposition: "cancelled",
        lastDeliveryReason: "operator_cancelled",
        version: sql`${chatQueuedMessages.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatQueuedMessages.conversationId, input.conversationId),
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.status, "dequeue_claimed"),
          isNotNull(chatQueuedMessages.cancelledAt),
          isNull(chatQueuedMessages.deliveryLeaseToken),
          isNull(chatQueuedMessages.continuationGenerationId),
        ),
      )
      .returning();
    if (cancelledRow) return hydrateQueuedMessage(cancelledRow);
    const [row] = await db
      .update(chatQueuedMessages)
      .set({
        status: "queued",
        lastDeliveryReason: input.reason,
        version: sql`${chatQueuedMessages.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatQueuedMessages.conversationId, input.conversationId),
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.status, "dequeue_claimed"),
          isNull(chatQueuedMessages.cancelledAt),
          isNull(chatQueuedMessages.deliveryLeaseToken),
          isNull(chatQueuedMessages.continuationGenerationId),
        ),
      )
      .returning();
    return row ? hydrateQueuedMessage(row) : null;
  }

  async function reclaimStaleQueuedMessageClaims(conversationId: string) {
    const cutoff = new Date(Date.now() - QUEUED_MESSAGE_CLAIM_LEASE_MS);
    const now = new Date();
    await db
      .update(chatQueuedMessages)
      .set({
        status: "cancelled",
        deliveryDisposition: "cancelled",
        lastDeliveryReason: "operator_cancelled",
        version: sql`${chatQueuedMessages.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatQueuedMessages.conversationId, conversationId),
          eq(chatQueuedMessages.status, "dequeue_claimed"),
          isNotNull(chatQueuedMessages.cancelledAt),
          isNull(chatQueuedMessages.deliveryLeaseToken),
          isNull(chatQueuedMessages.continuationGenerationId),
          lt(chatQueuedMessages.updatedAt, cutoff),
        ),
      );
    await db
      .update(chatQueuedMessages)
      .set({
        status: "queued",
        lastDeliveryReason: "claim_expired",
        version: sql`${chatQueuedMessages.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatQueuedMessages.conversationId, conversationId),
          eq(chatQueuedMessages.status, "dequeue_claimed"),
          isNull(chatQueuedMessages.cancelledAt),
          isNull(chatQueuedMessages.deliveryLeaseToken),
          isNull(chatQueuedMessages.continuationGenerationId),
          lt(chatQueuedMessages.updatedAt, cutoff),
        ),
      );
  }

  async function assertQueuedMessageClaimedForDelivery(input: {
    conversationId: string;
    itemId: string;
    body: string;
  }) {
    const row = await db
      .select()
      .from(chatQueuedMessages)
      .where(
        and(
          eq(chatQueuedMessages.conversationId, input.conversationId),
          eq(chatQueuedMessages.id, input.itemId),
          isNull(chatQueuedMessages.cancelledAt),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row || row.status !== "dequeue_claimed") {
      throw conflict("Queued message is not claimed for delivery");
    }
    const payload = normalizeQueuedPayload(row.payload);
    if (payload.body.trim() !== input.body.trim()) {
      throw conflict("Queued message body no longer matches claimed payload");
    }
    return hydrateQueuedMessage(row);
  }

  async function markQueuedMessageRunning(input: {
    conversationId: string;
    itemId: string;
    sourceMessageId: string;
  }) {
    const now = new Date();
    const [row] = await db
      .update(chatQueuedMessages)
      .set({
        status: "running",
        sourceMessageId: input.sourceMessageId,
        deliveredMessageId: input.sourceMessageId,
        version: sql`${chatQueuedMessages.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatQueuedMessages.conversationId, input.conversationId),
          eq(chatQueuedMessages.id, input.itemId),
          eq(chatQueuedMessages.status, "dequeue_claimed"),
        ),
      )
      .returning();
    if (!row) throw conflict("Queued message is no longer deliverable");
    return hydrateQueuedMessage(row);
  }

  async function markQueuedMessageDeliveryTerminal(input: {
    conversationId: string;
    itemId: string;
    status: "completed" | "failed" | "stopped" | "aborted";
  }) {
    const now = new Date();
    const nextStatus = input.status === "completed" ? "completed" : "failed";
    const [row] = await db
      .update(chatQueuedMessages)
      .set({
        status: nextStatus,
        lastDeliveryReason: input.status === "completed" ? null : input.status,
        version: sql`${chatQueuedMessages.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatQueuedMessages.conversationId, input.conversationId),
          eq(chatQueuedMessages.id, input.itemId),
          inArray(chatQueuedMessages.status, ["dequeue_claimed", "running"]),
        ),
      )
      .returning();
    return row ? hydrateQueuedMessage(row) : null;
  }

  async function hydrateMessages(rows: MessageHydrationRow[], options: { includeTranscript?: boolean } = {}) {
    const includeTranscript = options.includeTranscript !== false;
    const assistantMessageIds = rows
      .filter((row) => row.role === "assistant")
      .map((row) => row.id);
    const nativeSteerMessageIds = rows
      .filter((row) => row.role === "user" && row.structuredPayload?.source === "steer")
      .map((row) => row.id);
    const [attachmentsByMessageId, approvalsById, generationMessageRows, linkedSteerQueueRows] = await Promise.all([
      listAttachmentsForMessageIds(rows.map((row) => row.id)),
      listApprovalsForMessages(rows),
      assistantMessageIds.length > 0
        ? db
          .select({
            assistantMessageId: chatGenerationEvents.assistantMessageId,
            generationId: chatGenerationEvents.generationId,
          })
          .from(chatGenerationEvents)
          .where(inArray(chatGenerationEvents.assistantMessageId, assistantMessageIds))
          .orderBy(desc(chatGenerationEvents.generationSeq))
        : Promise.resolve([]),
      nativeSteerMessageIds.length > 0
        ? db
          .select({
            sourceMessageId: chatQueuedMessages.sourceMessageId,
            continuationMessageId: chatQueuedMessages.continuationMessageId,
            deliveryDisposition: chatQueuedMessages.deliveryDisposition,
            continuationGenerationId: chatQueuedMessages.continuationGenerationId,
            dequeuedAt: chatQueuedMessages.dequeuedAt,
          })
          .from(chatQueuedMessages)
          .where(or(
            inArray(chatQueuedMessages.sourceMessageId, nativeSteerMessageIds),
            inArray(chatQueuedMessages.continuationMessageId, nativeSteerMessageIds),
          ))
        : Promise.resolve([]),
    ]);
    const generationIdByAssistantMessageId = new Map<string, string>();
    for (const generationMessageRow of generationMessageRows) {
      if (!generationMessageRow.assistantMessageId) continue;
      if (generationIdByAssistantMessageId.has(generationMessageRow.assistantMessageId)) continue;
      generationIdByAssistantMessageId.set(
        generationMessageRow.assistantMessageId,
        generationMessageRow.generationId,
      );
    }
    const steerDispositionByMessageId = new Map<string, string>();
    for (const queueRow of linkedSteerQueueRows) {
      const messageIds = new Set([
        queueRow.sourceMessageId,
        queueRow.continuationMessageId,
      ].filter((messageId): messageId is string => Boolean(messageId)));
      // `dequeuedAt` is durable provenance that this feedback left the native turn.
      // A failed continuation claim clears continuationGenerationId and may become
      // acceptance_unknown, but it must never be projected back into the old transcript.
      const projectedDisposition = queueRow.continuationGenerationId || queueRow.dequeuedAt
        ? "continuation_pending"
        : queueRow.deliveryDisposition === "delivered"
          ? "accepted_current"
          : queueRow.deliveryDisposition;
      if (!projectedDisposition) continue;
      for (const messageId of messageIds) {
        steerDispositionByMessageId.set(messageId, projectedDisposition);
      }
    }
    const effectiveStructuredPayload = (row: MessageHydrationRow) => {
      const payload = row.structuredPayload;
      if (!payload || payload.source !== "steer") return payload;
      const projectedDisposition = steerDispositionByMessageId.get(row.id);
      return projectedDisposition
        ? { ...payload, deliveryDisposition: projectedDisposition }
        : payload;
    };
    const nativeSteerTargetGenerationIds = new Set<string>();
    for (const row of rows) {
      const payload = effectiveStructuredPayload(row);
      const targetGenerationId = payload?.source === "steer"
        && ["pending", "acceptance_unknown", "accepted_current"].includes(
          typeof payload.deliveryDisposition === "string" ? payload.deliveryDisposition : "",
        )
        && typeof payload.targetGenerationId === "string"
        ? payload.targetGenerationId
        : null;
      if (targetGenerationId) nativeSteerTargetGenerationIds.add(targetGenerationId);
    }
    const nativeSteerAssistantMessageIds = includeTranscript
      ? []
      : assistantMessageIds.filter((messageId) => {
        const generationId = generationIdByAssistantMessageId.get(messageId);
        return Boolean(generationId && nativeSteerTargetGenerationIds.has(generationId));
      });
    const nativeSteerTranscriptPayloadByMessageId = new Map<string, Record<string, unknown> | null>();
    if (nativeSteerAssistantMessageIds.length > 0) {
      const transcriptPayloadRows = await db
        .select({
          id: chatMessages.id,
          structuredPayload: chatMessages.structuredPayload,
        })
        .from(chatMessages)
        .where(inArray(chatMessages.id, nativeSteerAssistantMessageIds));
      for (const transcriptPayloadRow of transcriptPayloadRows) {
        nativeSteerTranscriptPayloadByMessageId.set(
          transcriptPayloadRow.id,
          transcriptPayloadRow.structuredPayload,
        );
      }
    }

    return rows.map((row) => {
      const generationId = generationIdByAssistantMessageId.get(row.id) ?? null;
      const includeRowTranscript = includeTranscript
        || Boolean(generationId && nativeSteerTargetGenerationIds.has(generationId));
      const transcriptPayload = nativeSteerTranscriptPayloadByMessageId.get(row.id) ?? row.structuredPayload;
      const transcript = includeRowTranscript ? chatTranscriptFromPayload(transcriptPayload) : [];
      const transcriptSummary = includeRowTranscript
        ? chatTranscriptSummaryFromEntries(transcript)
        : row.transcriptSummary ?? null;
      const structuredPayload = effectiveStructuredPayload(row);
      return {
        ...row,
        generationId,
        structuredPayload: stripChatMetadataFromPayload(structuredPayload),
        transcript: includeRowTranscript ? transcript : undefined,
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
      const activityAtSql = sql<Date>`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt})`;
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

  async function create(orgId: string, data: CreateChatInput) {
    const created = await createChatConversation(db, orgId, data);
    return getById(created.id);
  }

  async function createWithInitialMessage(
    orgId: string,
    data: CreateChatWithInitialMessageInput,
    executor?: Db,
  ) {
    return createChatWithInitialMessage(db, orgId, data, executor);
  }

  function forkSystemEventBody(sourceConversation: ConversationRow, sourceMessageId: string | null) {
    const messageSuffix = sourceMessageId ? " at message" : "";
    return `Forked from [${sourceConversation.title}](chat://${sourceConversation.id})${messageSuffix}.`;
  }

  async function forkConversation(input: {
    sourceConversationId: string;
    orgId: string;
    userId: string;
    sourceMessageId?: string | null;
    title?: string | null;
    createdByUserId: string | null;
  }) {
    const created = await db.transaction(async (tx) => {
      const initialSource = await tx
        .select()
        .from(chatConversations)
        .where(and(eq(chatConversations.id, input.sourceConversationId), eq(chatConversations.orgId, input.orgId)))
        .then((rows) => rows[0] ?? null);
      if (!initialSource) throw notFound("Chat conversation not found");

      const initialRootConversationId = initialSource.forkRootConversationId ?? initialSource.id;
      await tx.execute(sql`
        SELECT ${chatConversations.id}
        FROM ${chatConversations}
        WHERE ${chatConversations.id} = ${initialRootConversationId}
        FOR UPDATE
      `);
      if (initialSource.id !== initialRootConversationId) {
        await tx.execute(sql`
          SELECT ${chatConversations.id}
          FROM ${chatConversations}
          WHERE ${chatConversations.id} = ${initialSource.id}
          FOR UPDATE
        `);
      }

      const source = await tx
        .select()
        .from(chatConversations)
        .where(and(eq(chatConversations.id, input.sourceConversationId), eq(chatConversations.orgId, input.orgId)))
        .then((rows) => rows[0] ?? null);
      if (!source) throw notFound("Chat conversation not found");

      const rootConversationId = source.forkRootConversationId ?? source.id;
      const familyTitles = await tx
        .select({ title: chatConversations.title })
        .from(chatConversations)
        .where(and(
          eq(chatConversations.orgId, input.orgId),
          or(
            eq(chatConversations.id, rootConversationId),
            eq(chatConversations.forkRootConversationId, rootConversationId),
          ),
        ))
        .then((rows) => rows.map((row) => row.title));
      const childTitle = input.title?.trim() || nextForkTitle(source, familyTitles);
      const messageConditions = [
        eq(chatMessages.conversationId, source.id),
        eq(chatMessages.orgId, input.orgId),
        isNull(chatMessages.supersededAt),
      ];
      let forkSourceCreatedAt: Date | null = null;
      if (input.sourceMessageId) {
        const sourceMessage = await tx
          .select({
            id: chatMessages.id,
            kind: chatMessages.kind,
            role: chatMessages.role,
            createdAt: chatMessages.createdAt,
          })
          .from(chatMessages)
          .where(and(...messageConditions, eq(chatMessages.id, input.sourceMessageId)))
          .then((rows) => rows[0] ?? null);
        if (!sourceMessage) throw unprocessable("Fork source message must belong to the source conversation");
        if (sourceMessage.role !== "assistant" || sourceMessage.kind !== "message") {
          throw unprocessable("Fork source message must be an assistant response");
        }
        forkSourceCreatedAt = sourceMessage.createdAt;
      }

      const now = new Date();
      const [child] = await tx
        .insert(chatConversations)
        .values({
          orgId: input.orgId,
          status: "active",
          title: childTitle,
          summary: source.summary,
          preferredAgentId: source.preferredAgentId,
          routedAgentId: source.routedAgentId,
          primaryIssueId: source.primaryIssueId,
          forkedFromConversationId: source.id,
          forkedFromMessageId: input.sourceMessageId ?? null,
          forkRootConversationId: rootConversationId,
          issueCreationMode: source.issueCreationMode,
          planMode: source.planMode,
          createdByUserId: input.createdByUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!child) throw new Error("Failed to create forked chat conversation");

      const contextLinks = await tx
        .select()
        .from(chatContextLinks)
        .where(eq(chatContextLinks.conversationId, source.id))
        .orderBy(chatContextLinks.createdAt);
      if (contextLinks.length > 0) {
        await tx
          .insert(chatContextLinks)
          .values(contextLinks.map((link) => ({
            orgId: input.orgId,
            conversationId: child.id,
            entityType: link.entityType,
            entityId: link.entityId,
            metadata: link.metadata,
          })))
          .onConflictDoNothing();
      }

      const messagesToCopy = await tx
        .select()
        .from(chatMessages)
        .where(and(
          ...messageConditions,
          ...(forkSourceCreatedAt && input.sourceMessageId
            ? [or(lt(chatMessages.createdAt, forkSourceCreatedAt), eq(chatMessages.id, input.sourceMessageId))]
            : []),
        ))
        .orderBy(chatMessages.createdAt, chatMessages.id);
      const forkMessages = input.sourceMessageId
        ? messagesToCopy.slice(0, messagesToCopy.findIndex((message) => message.id === input.sourceMessageId) + 1)
        : messagesToCopy;
      await copyForkInlineVisualMessages({
        tx,
        messages: forkMessages,
        sourceConversationId: source.id,
        targetConversationId: child.id,
        orgId: input.orgId,
      });

      const [systemEvent] = await tx
        .insert(chatMessages)
        .values({
          orgId: input.orgId,
          conversationId: child.id,
          role: "system",
          kind: "system_event",
          status: "completed",
          body: forkSystemEventBody(source, input.sourceMessageId ?? null),
          structuredPayload: {
            eventType: "chat_fork",
            type: "chat_fork",
            sourceConversationId: source.id,
            sourceConversationTitle: source.title,
            sourceMessageId: input.sourceMessageId ?? null,
            forkRootConversationId: rootConversationId,
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx
        .update(chatConversations)
        .set({
          lastMessageAt: systemEvent?.createdAt ?? now,
          updatedAt: now,
        })
        .where(eq(chatConversations.id, child.id));

      await ensureChatFamilyGroup(tx, {
        orgId: input.orgId,
        userId: input.userId,
        rootConversationId,
        sourceConversationId: source.id,
        childConversationId: child.id,
        groupName: source.title,
      });

      return child;
    });

    return getById(created.id, input.userId);
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

  async function updateDefaultTitle(id: string, title: string, expectedCurrentTitle = "New chat") {
    const [updated] = await db
      .update(chatConversations)
      .set({
        title,
        updatedAt: new Date(),
      })
      .where(and(eq(chatConversations.id, id), eq(chatConversations.title, expectedCurrentTitle)))
      .returning();
    if (!updated) return null;
    return getById(id);
  }

  async function replaceSystemGeneratedTitle(id: string, expectedTitle: string, title: string) {
    const [updated] = await db
      .update(chatConversations)
      .set({
        title,
        updatedAt: new Date(),
      })
      .where(and(
        eq(chatConversations.id, id),
        inArray(chatConversations.title, [expectedTitle, "New chat"]),
      ))
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

  async function assetHasAttachments(assetId: string) {
    const [row] = await db
      .select({ id: chatAttachments.id })
      .from(chatAttachments)
      .where(eq(chatAttachments.assetId, assetId))
      .limit(1);
    return Boolean(row);
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
        await tx.delete(assets).where(and(
          inArray(assets.id, assetIds),
          sql<boolean>`not exists (
            select 1 from ${chatAttachments}
            where ${chatAttachments.assetId} = ${assets.id}
          )`,
        ));
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

  function transcriptSummarySql() {
    const transcript = sql`${chatMessages.structuredPayload}->${CHAT_TRANSCRIPT_KEY}`;
    return sql<MessageHydrationRow["transcriptSummary"]>`
      case
        when jsonb_typeof(${transcript}) = 'array'
          and jsonb_array_length(${transcript}) > 0
        then jsonb_build_object(
          'entryCount', jsonb_array_length(${transcript}),
          'startedAt', (
            select min(entry.value->>'ts')
            from jsonb_array_elements(${transcript}) as entry(value)
            where entry.value ? 'ts'
          ),
          'endedAt', (
            select max(entry.value->>'ts')
            from jsonb_array_elements(${transcript}) as entry(value)
            where entry.value ? 'ts'
          )
        )
        else null
      end
    `;
  }

  function structuredPayloadWithoutTranscriptSql() {
    return sql<Record<string, unknown> | null>`
      case
        when ${chatMessages.structuredPayload} is null then null
        when ${chatMessages.structuredPayload} ? ${CHAT_TRANSCRIPT_KEY}
        then nullif(${chatMessages.structuredPayload} - ${CHAT_TRANSCRIPT_KEY}, '{}'::jsonb)
        else ${chatMessages.structuredPayload}
      end
    `;
  }

  async function listRecentUserMessages(conversationId: string, limit: number) {
      return listRecentUserChatMessages(db, conversationId, limit);
  }

  async function listMessages(conversationId: string, options: { includeTranscript?: boolean } = {}) {
      const includeTranscript = options.includeTranscript !== false;
      const conversationOrgIds = db
        .select({ orgId: chatConversations.orgId })
        .from(chatConversations)
        .where(eq(chatConversations.id, conversationId));
      const messageConditions = and(
        eq(chatMessages.conversationId, conversationId),
        inArray(chatMessages.orgId, conversationOrgIds),
      );
      const rows = includeTranscript
        ? await db
          .select()
          .from(chatMessages)
          .where(messageConditions)
          .orderBy(chatMessages.createdAt, chatMessages.id)
        : await db
          .select({
            id: chatMessages.id,
            orgId: chatMessages.orgId,
            conversationId: chatMessages.conversationId,
            role: chatMessages.role,
            kind: chatMessages.kind,
            status: chatMessages.status,
            body: chatMessages.body,
            structuredPayload: structuredPayloadWithoutTranscriptSql(),
            approvalId: chatMessages.approvalId,
            runId: chatMessages.runId,
            replyingAgentId: chatMessages.replyingAgentId,
            chatTurnId: chatMessages.chatTurnId,
            turnVariant: chatMessages.turnVariant,
            supersededAt: chatMessages.supersededAt,
            createdAt: chatMessages.createdAt,
            updatedAt: chatMessages.updatedAt,
            transcriptSummary: transcriptSummarySql(),
          })
          .from(chatMessages)
          .where(messageConditions)
          .orderBy(chatMessages.createdAt, chatMessages.id);
      return hydrateMessages(rows, { includeTranscript });
  }

  async function getMessageTranscript(conversationId: string, messageId: string) {
      const row = await db
        .select({
          id: chatMessages.id,
          structuredPayload: chatMessages.structuredPayload,
        })
        .from(chatMessages)
        .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.id, messageId)))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return {
        messageId: row.id,
        transcript: chatTranscriptFromPayload(row.structuredPayload),
      };
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
    options: { structuredPayload?: Record<string, unknown> | null } = {},
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
      structuredPayload: options.structuredPayload ?? null,
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
        runId?: string | null;
        replyingAgentId?: string | null;
        chatTurnId?: string | null;
        turnVariant?: number;
      },
    ) {
      const durableBody = input.role === "user"
        ? input.body
        : await normalizeLocalLibraryPathMarkdown(input.body, input.orgId);
      const [message] = await db
        .insert(chatMessages)
        .values({
          orgId: input.orgId,
          conversationId,
          role: input.role,
          kind: input.kind,
          status: input.status ?? "completed",
          body: durableBody,
          structuredPayload: withPersistedTranscript(
            sanitizeChatStructuredPayload(input.structuredPayload ?? null),
            input.transcript ?? [],
          ),
          approvalId: input.approvalId ?? null,
          runId: input.runId ?? null,
          replyingAgentId: input.replyingAgentId ?? null,
          chatTurnId: input.chatTurnId ?? null,
          turnVariant: input.turnVariant ?? 0,
        })
        .returning();
      if (!message) throw new Error("Failed to create chat message");
      if (input.role === "user" || isVisibleIncomingChatMessage(message)) {
        await refreshConversationTouch(conversationId, message.createdAt);
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
        runId?: string | null;
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
      const durableInputBody = input.body !== undefined && existing.role !== "user"
        ? await normalizeLocalLibraryPathMarkdown(input.body, existing.orgId)
        : input.body;
      const wasVisibleIncoming = isVisibleIncomingChatMessage(existing);
      const nextMessage = {
        role: existing.role,
        kind: input.kind ?? existing.kind,
        body: durableInputBody ?? existing.body,
        approvalId: input.approvalId !== undefined ? input.approvalId : existing.approvalId,
      } satisfies Pick<MessageRow, "role" | "kind" | "body" | "approvalId">;
      const isVisibleIncoming = isVisibleIncomingChatMessage(nextMessage);
      const becameVisibleIncoming = !wasVisibleIncoming && isVisibleIncoming;
      const visibleContentChanged =
        (durableInputBody !== undefined && safeTrim(durableInputBody) !== safeTrim(existing.body)) ||
        (input.kind !== undefined && input.kind !== existing.kind) ||
        (input.approvalId !== undefined && input.approvalId !== existing.approvalId);

      const [updated] = await db
        .update(chatMessages)
        .set({
          ...(becameVisibleIncoming ? { createdAt: now } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(durableInputBody !== undefined ? { body: durableInputBody } : {}),
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
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
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

  async function updateMessageInternalInlineVisuals(
    conversationId: string,
    messageId: string,
    input: {
      inlineVisuals?: ChatInlineVisualMapping[];
      inlineVisualsV1?: RudderInlineVisualMapping[];
    },
  ) {
    return updateTrustedInlineVisualMappings({
      db,
      hydrateMessages,
      conversationId,
      messageId,
      ...input,
    });
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

  async function removeAttachment(attachmentId: string) {
    return db.transaction(async (tx) => {
      const existing = await tx
        .select({
          id: chatAttachments.id,
          orgId: chatAttachments.orgId,
          assetId: chatAttachments.assetId,
          objectKey: assets.objectKey,
        })
        .from(chatAttachments)
        .innerJoin(assets, eq(chatAttachments.assetId, assets.id))
        .where(eq(chatAttachments.id, attachmentId))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      await tx.delete(chatAttachments).where(eq(chatAttachments.id, attachmentId));
      const hasRemainingAttachment = await tx
        .select({ id: chatAttachments.id })
        .from(chatAttachments)
        .where(eq(chatAttachments.assetId, existing.assetId))
        .limit(1)
        .then((rows) => rows.length > 0);
      if (!hasRemainingAttachment) {
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
      }
      return {
        orgId: existing.orgId,
        objectKey: existing.objectKey,
        assetDeleted: !hasRemainingAttachment,
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

  function issueProposalWithApprovalFeedback(
    issueProposal: Record<string, unknown>,
    decisionNote: string | null | undefined,
  ) {
    const feedback = safeTrim(decisionNote);
    if (!feedback) return issueProposal;
    const description = typeof issueProposal.description === "string" ? issueProposal.description.trimEnd() : "";
    return {
      ...issueProposal,
      description: [
        description,
        "",
        "## Approval feedback",
        "",
        feedback,
      ].join("\n"),
    };
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
        const proposedIssueWithFeedback = proposedIssue
          ? issueProposalWithApprovalFeedback(proposedIssue, approval.decisionNote)
          : proposedIssue;
        const issue = await convertToIssue(conversationId, {
          actorUserId,
          createdByAgentId: safeTrim(typeof payload.proposedByAgentId === "string" ? payload.proposedByAgentId : null),
          messageId,
          proposal: proposedIssueWithFeedback,
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
        const approvalFeedback = safeTrim(approval.decisionNote);
        if (approvalFeedback) {
          await addMessage(conversationId, {
            orgId: approval.orgId,
            role: "system",
            kind: "system_event",
            body: [
              "Approved with execution feedback:",
              "",
              approvalFeedback,
            ].join("\n"),
            structuredPayload: {
              eventType: "approval_feedback",
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              approvalId: approval.id,
              decisionNote: approvalFeedback,
            },
          });
        }
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
    generationProtocol,
    list,
    listSummaries,
    listPinnedSummaries,
    listSummariesByIds,
    getById,
    create,
    createWithInitialMessage,
    update,
    updateDefaultTitle,
    replaceSystemGeneratedTitle,
    listRecentUserMessages,
    listAttachmentsForConversation,
    assetHasAttachments,
    remove,
    forkConversation,
    resolve,
    markRead,
    markUnread,
    setPinned,
    createGeneration,
    beginGenerationControlAttempt,
    markGenerationControlReady,
    renewGenerationControlLease,
    markGenerationControlAttemptCompleted,
    appendGenerationEvent,
    markGenerationTerminal,
    getLatestActiveGeneration,
    getLatestGeneration,
    getQueueSnapshot,
    listQueuedMessages,
    createQueuedMessage,
    updateQueuedMessage,
    cancelQueuedMessage,
    scheduleSteerContinuation,
    markQueuedMessageSteerFallback,
    beginSteerControlAction,
    claimSteerProviderSend,
    releaseSteerProviderSendClaim,
    resolveSteerControlAction,
    claimNextServerQueuedMessage,
    renewServerQueuedMessageClaim,
    completeServerQueuedMessageDelivery,
    releaseServerQueuedMessageClaim,
    recoverExpiredServerQueueClaims,
    claimNextQueuedMessage,
    releaseQueuedMessageClaim,
    assertQueuedMessageClaimedForDelivery,
    markQueuedMessageRunning,
    markQueuedMessageDeliveryTerminal,
    listMessages,
    getMessageTranscript,
    addMessage,
    updateMessage,
    updateMessageInternalInlineVisuals,
    markInterruptedStreamingMessages,
    addUserChatMessage,
    addContextLink,
    setProjectContextLink,
    createAttachment,
    removeAttachment,
    convertToIssue,
    getMessage,
    applyApprovedApproval,
    createProposalApproval,
    resolveOperationProposal,
  };
}
