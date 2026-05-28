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
type ContextLinkRow = typeof chatContextLinks.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

export const CHAT_TRANSCRIPT_KEY = "__chatTranscript";

const ISSUE_PROPOSAL_PRIORITIES = ["critical", "high", "medium", "low"] as const;

type ChatIssueProposalPriority = typeof ISSUE_PROPOSAL_PRIORITIES[number];

export type ChatIssueProposalPayload = {
  title: string;
  description: string;
  priority: ChatIssueProposalPriority;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  assigneeUnassignedReason: string | null;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  labelIds?: string[];
};

export function isIssueProposalPriority(value: unknown): value is ChatIssueProposalPriority {
  return typeof value === "string" && ISSUE_PROPOSAL_PRIORITIES.includes(value as ChatIssueProposalPriority);
}

export function contentPath(assetId: string) {
  return `/api/assets/${assetId}/content`;
}

export function safeTrim(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function isVisibleIncomingChatMessage(
  message: Pick<MessageRow, "role" | "kind" | "body" | "approvalId">,
) {
  if (message.role === "user") return false;
  return Boolean(safeTrim(message.body)) || message.kind !== "message" || Boolean(message.approvalId);
}

export function visibleIncomingMessageSql() {
  return sql`(
    ${chatMessages.role} <> 'user'
    and (
      btrim(${chatMessages.body}) <> ''
      or ${chatMessages.kind} <> 'message'
      or ${chatMessages.approvalId} is not null
    )
  )`;
}

export function incomingMessagePreviewSql() {
  return sql`(${chatMessages.role} <> 'user' and btrim(${chatMessages.body}) <> '')`;
}

export function truncatePreview(value: string | null | undefined, max = 140) {
  return formatMessengerPreview(value, { max });
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function textContains(value: string | null | undefined, query: string): value is string {
  return Boolean(value && value.toLowerCase().includes(query.toLowerCase()));
}

export function buildSearchSnippet(value: string, query: string, maxLength = 160) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;

  const index = compact.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return `${compact.slice(0, maxLength - 1).trimEnd()}...`;

  const context = Math.max(20, Math.floor((maxLength - query.length) / 2));
  const start = Math.max(0, index - context);
  const end = Math.min(compact.length, start + maxLength);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`;
}

export function chatTranscriptFromPayload(
  payload: Record<string, unknown> | null | undefined,
): ChatStreamTranscriptEntry[] {
  const transcript = payload?.[CHAT_TRANSCRIPT_KEY];
  return Array.isArray(transcript) ? (transcript as ChatStreamTranscriptEntry[]) : [];
}

export function stripChatMetadataFromPayload(payload: Record<string, unknown> | null | undefined) {
  if (!payload) return null;
  if (!(CHAT_TRANSCRIPT_KEY in payload)) return payload;
  const { [CHAT_TRANSCRIPT_KEY]: _ignored, ...rest } = payload;
  return Object.keys(rest).length > 0 ? rest : null;
}

export function withPersistedTranscript(
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

export function issueProposalFromPayload(payload: Record<string, unknown> | null | undefined): ChatIssueProposalPayload | null {
  const root = payload ?? {};
  const proposal =
    root.issueProposal && typeof root.issueProposal === "object" && !Array.isArray(root.issueProposal)
      ? (root.issueProposal as Record<string, unknown>)
      : root;

  const title = safeTrim(typeof proposal.title === "string" ? proposal.title : null);
  const description = safeTrim(typeof proposal.description === "string" ? proposal.description : null);
  if (!title || !description) return null;

  return {
    title,
    description,
    priority: isIssueProposalPriority(proposal.priority) ? proposal.priority : "medium",
    projectId: safeTrim(typeof proposal.projectId === "string" ? proposal.projectId : null),
    goalId: safeTrim(typeof proposal.goalId === "string" ? proposal.goalId : null),
    parentId: safeTrim(typeof proposal.parentId === "string" ? proposal.parentId : null),
    assigneeAgentId: safeTrim(typeof proposal.assigneeAgentId === "string" ? proposal.assigneeAgentId : null),
    assigneeUserId: safeTrim(typeof proposal.assigneeUserId === "string" ? proposal.assigneeUserId : null),
    assigneeUnassignedReason: safeTrim(
      typeof proposal.assigneeUnassignedReason === "string" ? proposal.assigneeUnassignedReason : null,
    ),
    reviewerAgentId: safeTrim(typeof proposal.reviewerAgentId === "string" ? proposal.reviewerAgentId : null),
    reviewerUserId: safeTrim(typeof proposal.reviewerUserId === "string" ? proposal.reviewerUserId : null),
    labelIds: Array.isArray(proposal.labelIds)
      ? proposal.labelIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : undefined,
  };
}

export function planDocumentFromPayload(
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

export function operationProposalFromPayload(payload: Record<string, unknown> | null | undefined) {
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

export function operationProposalDecisionStatusFromPayload(payload: Record<string, unknown> | null | undefined) {
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

export function withOperationProposalDecisionState(
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

export async function resolveContextEntities(db: Db, rows: ContextLinkRow[]) {
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
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
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
    description?: string | null;
    priority?: string | null;
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
      description: row.description,
      priority: row.priority,
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

export async function listContextLinksForConversationIds(db: Db, conversationIds: string[]) {
  if (conversationIds.length === 0) return new Map<string, Awaited<ReturnType<typeof resolveContextEntities>>>();
  const rows = await db
    .select()
    .from(chatContextLinks)
    .where(inArray(chatContextLinks.conversationId, conversationIds))
    .orderBy(chatContextLinks.createdAt);
  const resolved = await resolveContextEntities(db, rows);
  const map = new Map<string, typeof resolved>();
  for (const row of resolved) {
    const list = map.get(row.conversationId);
    if (list) list.push(row);
    else map.set(row.conversationId, [row]);
  }
  return map;
}

export async function listPrimaryIssues(db: Db, conversationRows: ConversationRow[]) {
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
