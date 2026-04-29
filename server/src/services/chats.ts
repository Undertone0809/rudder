import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import type { ChatMessageKind, ChatStreamTranscriptEntry } from "@rudderhq/shared";
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
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";
import { organizationService } from "./orgs.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";

type ConversationRow = typeof chatConversations.$inferSelect;
type ConversationUserStateRow = typeof chatConversationUserStates.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;
type ContextLinkRow = typeof chatContextLinks.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

const CHAT_TRANSCRIPT_KEY = "__chatTranscript";

function contentPath(assetId: string) {
  return `/api/assets/${assetId}/content`;
}

function safeTrim(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function firstLine(value: string | null | undefined) {
  if (!value) return null;
  const line = value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line ?? null;
}

function truncatePreview(value: string | null | undefined, max = 140) {
  const text = firstLine(value)?.replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function chatTranscriptFromPayload(
  payload: Record<string, unknown> | null | undefined,
): ChatStreamTranscriptEntry[] {
  const transcript = payload?.[CHAT_TRANSCRIPT_KEY];
  return Array.isArray(transcript) ? (transcript as ChatStreamTranscriptEntry[]) : [];
}

function stripChatMetadataFromPayload(payload: Record<string, unknown> | null | undefined) {
  if (!payload) return null;
  if (!(CHAT_TRANSCRIPT_KEY in payload)) return payload;
  const { [CHAT_TRANSCRIPT_KEY]: _ignored, ...rest } = payload;
  return Object.keys(rest).length > 0 ? rest : null;
}

function withPersistedTranscript(
  payload: Record<string, unknown> | null | undefined,
  transcript: ChatStreamTranscriptEntry[] | null | undefined,
) {
  const cleanPayload = stripChatMetadataFromPayload(payload);
  if (!transcript || transcript.length === 0) {
    return cleanPayload;
  }
  return {
    ...(cleanPayload ?? {}),
    [CHAT_TRANSCRIPT_KEY]: transcript,
  };
}

function issueProposalFromPayload(payload: Record<string, unknown> | null | undefined) {
  const root = payload ?? {};
  const proposal =
    root.issueProposal && typeof root.issueProposal === "object" && !Array.isArray(root.issueProposal)
      ? (root.issueProposal as Record<string, unknown>)
      : root;

  const title = safeTrim(typeof proposal.title === "string" ? proposal.title : null);
  const description = safeTrim(typeof proposal.description === "string" ? proposal.description : null);
  if (!title || !description) return null;

  const assigneeAgentId = safeTrim(typeof proposal.assigneeAgentId === "string" ? proposal.assigneeAgentId : null);
  const assigneeUserId = safeTrim(typeof proposal.assigneeUserId === "string" ? proposal.assigneeUserId : null);
  const explicitStatus =
    typeof proposal.status === "string" &&
    ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"].includes(proposal.status)
      ? proposal.status
      : null;

  return {
    title,
    description,
    priority:
      typeof proposal.priority === "string" &&
      ["critical", "high", "medium", "low"].includes(proposal.priority)
        ? proposal.priority
        : "medium",
    status: explicitStatus ?? (assigneeAgentId || assigneeUserId ? "todo" : undefined),
    projectId: safeTrim(typeof proposal.projectId === "string" ? proposal.projectId : null),
    goalId: safeTrim(typeof proposal.goalId === "string" ? proposal.goalId : null),
    parentId: safeTrim(typeof proposal.parentId === "string" ? proposal.parentId : null),
    assigneeAgentId,
    assigneeUserId,
  };
}

function planDocumentFromPayload(
  payload: Record<string, unknown> | null | undefined,
  fallbackBody?: string | null,
) {
  const root = payload ?? {};
  const rawDocument =
    root.planDocument && typeof root.planDocument === "object" && !Array.isArray(root.planDocument)
      ? (root.planDocument as Record<string, unknown>)
      : root.plan && typeof root.plan === "object" && !Array.isArray(root.plan)
        ? (root.plan as Record<string, unknown>)
        : null;

  const title = safeTrim(typeof rawDocument?.title === "string" ? rawDocument.title : null) ?? "Plan";
  const body =
    safeTrim(typeof rawDocument?.body === "string" ? rawDocument.body : null)
    ?? safeTrim(fallbackBody);
  if (!body) return null;

  return {
    title,
    body,
    changeSummary:
      safeTrim(typeof rawDocument?.changeSummary === "string" ? rawDocument.changeSummary : null)
      ?? "Created from chat plan mode",
  };
}

function operationProposalFromPayload(payload: Record<string, unknown> | null | undefined) {
  const root = payload ?? {};
  const proposal =
    root.operationProposal && typeof root.operationProposal === "object" && !Array.isArray(root.operationProposal)
      ? (root.operationProposal as Record<string, unknown>)
      : root;

  const targetType = typeof proposal.targetType === "string" ? proposal.targetType : null;
  const targetId = safeTrim(typeof proposal.targetId === "string" ? proposal.targetId : null);
  const summary = safeTrim(typeof proposal.summary === "string" ? proposal.summary : null);
  const patch =
    proposal.patch && typeof proposal.patch === "object" && !Array.isArray(proposal.patch)
      ? (proposal.patch as Record<string, unknown>)
      : null;

  if ((targetType !== "organization" && targetType !== "agent") || !targetId || !summary || !patch) {
    return null;
  }

  return {
    targetType,
    targetId,
    summary,
    patch,
  };
}

function operationProposalDecisionStatusFromPayload(payload: Record<string, unknown> | null | undefined) {
  const root = payload ?? {};
  const rawState =
    root.operationProposalState && typeof root.operationProposalState === "object" && !Array.isArray(root.operationProposalState)
      ? (root.operationProposalState as Record<string, unknown>)
      : null;

  const status = typeof rawState?.status === "string"
    && ["pending", "approved", "rejected", "revision_requested"].includes(rawState.status)
    ? rawState.status
    : "pending";

  return {
    status,
    decisionNote: safeTrim(typeof rawState?.decisionNote === "string" ? rawState.decisionNote : null),
    decidedByUserId: safeTrim(typeof rawState?.decidedByUserId === "string" ? rawState.decidedByUserId : null),
    decidedAt: safeTrim(typeof rawState?.decidedAt === "string" ? rawState.decidedAt : null),
  } as const;
}

function withOperationProposalDecisionState(
  payload: Record<string, unknown> | null | undefined,
  state: {
    status: "pending" | "approved" | "rejected" | "revision_requested";
    decisionNote: string | null;
    decidedByUserId: string | null;
    decidedAt: string | null;
  },
) {
  return {
    ...(payload ?? {}),
    operationProposalState: state,
  };
}

export function chatService(db: Db) {
  const issuesSvc = issueService(db);
  const approvalsSvc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const organizationsSvc = organizationService(db);
  const agentsSvc = agentService(db);
  const documentsSvc = documentService(db);
  const heartbeat = heartbeatService(db);

  async function resolveContextEntities(rows: ContextLinkRow[]) {
    const issueIds = rows.filter((row) => row.entityType === "issue").map((row) => row.entityId);
    const projectIds = rows.filter((row) => row.entityType === "project").map((row) => row.entityId);
    const agentIds = rows.filter((row) => row.entityType === "agent").map((row) => row.entityId);

    const [issueRows, projectRows, agentRows] = await Promise.all([
      issueIds.length
        ? db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
          })
          .from(issues)
          .where(inArray(issues.id, issueIds))
        : Promise.resolve([]),
      projectIds.length
        ? db
          .select({
            id: projects.id,
            name: projects.name,
            description: projects.description,
            status: projects.status,
          })
          .from(projects)
          .where(inArray(projects.id, projectIds))
        : Promise.resolve([]),
      agentIds.length
        ? db
          .select({
            id: agents.id,
            name: agents.name,
            title: agents.title,
            status: agents.status,
          })
          .from(agents)
          .where(inArray(agents.id, agentIds))
        : Promise.resolve([]),
    ]);

    const entityMap = new Map<string, {
      type: "issue" | "project" | "agent";
      id: string;
      label: string;
      subtitle: string | null;
      identifier: string | null;
      status: string | null;
      href: string;
    }>();

    for (const row of issueRows) {
      entityMap.set(`issue:${row.id}`, {
        type: "issue",
        id: row.id,
        label: row.title,
        subtitle: row.status,
        identifier: row.identifier,
        status: row.status,
        href: `/issues/${row.identifier ?? row.id}`,
      });
    }
    for (const row of projectRows) {
      entityMap.set(`project:${row.id}`, {
        type: "project",
        id: row.id,
        label: row.name,
        subtitle: row.description,
        identifier: null,
        status: row.status,
        href: `/projects/${row.id}`,
      });
    }
    for (const row of agentRows) {
      entityMap.set(`agent:${row.id}`, {
        type: "agent",
        id: row.id,
        label: row.name,
        subtitle: row.title,
        identifier: null,
        status: row.status,
        href: `/agents/${row.id}`,
      });
    }

    return rows.map((row) => ({
      ...row,
      entity: entityMap.get(`${row.entityType}:${row.entityId}`) ?? null,
    }));
  }

  async function listContextLinksForConversationIds(conversationIds: string[]) {
    if (conversationIds.length === 0) return new Map<string, Awaited<ReturnType<typeof resolveContextEntities>>>();
    const rows = await db
      .select()
      .from(chatContextLinks)
      .where(inArray(chatContextLinks.conversationId, conversationIds))
      .orderBy(chatContextLinks.createdAt);
    const resolved = await resolveContextEntities(rows);
    const map = new Map<string, typeof resolved>();
    for (const row of resolved) {
      const list = map.get(row.conversationId);
      if (list) list.push(row);
      else map.set(row.conversationId, [row]);
    }
    return map;
  }

  async function listPrimaryIssues(conversationRows: ConversationRow[]) {
    const primaryIssueIds = conversationRows
      .map((row) => row.primaryIssueId)
      .filter((id): id is string => Boolean(id));
    if (primaryIssueIds.length === 0) return new Map<string, {
      id: string;
      identifier: string | null;
      title: string;
      status: string;
      priority: string;
    }>();

    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
      })
      .from(issues)
      .where(inArray(issues.id, primaryIssueIds));
    return new Map(rows.map((row) => [row.id, row]));
  }

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
          sql`${chatMessages.role} <> 'user'`,
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
          inArray(approvals.status, ["pending", "revision_requested"]),
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
          sql`${chatMessages.role} <> 'user'`,
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
          sql`${chatMessages.role} <> 'user'`,
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
      listContextLinksForConversationIds(rows.map((row) => row.id)),
      listPrimaryIssues(rows),
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

  async function hydrateMessages(rows: MessageRow[]) {
    const [attachmentsByMessageId, approvalsById] = await Promise.all([
      listAttachmentsForMessageIds(rows.map((row) => row.id)),
      listApprovalsForMessages(rows),
    ]);

    return rows.map((row) => ({
      ...row,
      structuredPayload: stripChatMetadataFromPayload(row.structuredPayload),
      transcript: chatTranscriptFromPayload(row.structuredPayload),
      approval: row.approvalId ? (approvalsById.get(row.approvalId) ?? null) : null,
      attachments: attachmentsByMessageId.get(row.id) ?? [],
    }));
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
    const nextTitle = body.split(/\r?\n/, 1)[0]?.trim().slice(0, 80);
    if (!nextTitle) return;
    await db
      .update(chatConversations)
      .set({ title: nextTitle, updatedAt: new Date() })
      .where(eq(chatConversations.id, conversationId));
  }

  async function list(
      orgId: string,
      options?: { status?: "active" | "resolved" | "archived" | "all" },
      userId?: string | null,
    ) {
      const status = options?.status ?? "active";
      const where =
        status === "all"
          ? eq(chatConversations.orgId, orgId)
          : and(eq(chatConversations.orgId, orgId), eq(chatConversations.status, status));
      const rows = await db
        .select()
        .from(chatConversations)
        .where(where)
        .orderBy(desc(sql`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt})`));
      return hydrateConversations(rows, userId);
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
      return addMessage(conversationId, {
        orgId,
        role: "user",
        kind: "message",
        body,
        chatTurnId: turnId,
        turnVariant: nextVariant,
      });
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
        kind: ChatMessageKind;
        status?: "completed" | "stopped" | "failed";
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
          structuredPayload: withPersistedTranscript(input.structuredPayload ?? null, input.transcript ?? []),
          approvalId: input.approvalId ?? null,
          replyingAgentId: input.replyingAgentId ?? null,
          chatTurnId: input.chatTurnId ?? null,
          turnVariant: input.turnVariant ?? 0,
        })
        .returning();
      if (!message) throw new Error("Failed to create chat message");
      await refreshConversationTouch(conversationId, message.createdAt);
      if (input.role === "user") {
        await maybePromoteConversationTitle(conversationId, input.body);
      }
      const [hydrated] = await hydrateMessages([message]);
      return hydrated;
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
            structuredPayload,
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
      const resolved = await resolveContextEntities(links);
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

  async function convertToIssue(
      conversationId: string,
      input: {
        actorUserId: string | null;
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

      let issueProposal = input.proposal ? issueProposalFromPayload(input.proposal) : null;
      let sourceMessage: MessageRow | null = null;

      if (!issueProposal) {
        const message = input.messageId
          ? await db
            .select()
            .from(chatMessages)
            .where(and(eq(chatMessages.id, input.messageId), eq(chatMessages.conversationId, conversationId)))
            .then((rows) => rows[0] ?? null)
          : await db
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

      const issue = await issuesSvc.create(conversation.orgId, {
        ...issueProposal,
        createdByUserId: input.actorUserId,
      });
      void queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "chat.convert_to_issue",
        requestedByActorType: input.actorUserId ? "user" : "system",
        requestedByActorId: input.actorUserId ?? "chat-assistant",
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
        const issue = await convertToIssue(conversationId, {
          actorUserId,
          messageId,
          proposal: proposedIssue,
        });
        await issueApprovalsSvc.linkManyForApproval(approval.id, [issue.id], {
          agentId: null,
          userId: actorUserId ?? "board",
        });
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
    getById,
    create,
    update,
    resolve,
    markRead,
    setPinned,
    listMessages,
    addMessage,
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
