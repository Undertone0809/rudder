import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  activityLog,
  approvalComments,
  approvals,
  agents,
  authUsers,
  chatConversations,
  heartbeatRuns,
  issueComments,
  issueFollows,
  issues,
  joinRequests,
  messengerThreadUserStates,
} from "@rudderhq/db";
import {
  formatMessengerPreview,
  formatMessengerTitle,
  type Approval,
  type BudgetIncident,
  type ChatConversation,
  type ChatMessage,
  type HeartbeatRun,
  type JoinRequest,
  type MessengerApprovalThreadItem,
  type MessengerBudgetThreadItem,
  type MessengerEvent,
  type MessengerHeartbeatRunThreadItem,
  type MessengerIssueThreadItem,
  type MessengerJoinRequestThreadItem,
  type MessengerSystemThreadKind,
  type MessengerThreadAction,
  type MessengerThreadDetail,
  type MessengerThreadPageInfo,
  type MessengerThreadSummary,
  type MessengerThreadSummaryPage,
} from "@rudderhq/shared";
import { chatService } from "./chats.js";
import { budgetService } from "./budgets.js";
import { redactEventPayload } from "../redaction.js";
import { conflict } from "../errors.js";

const ISSUE_ACTIVITY_ACTIONS = [
  "issue.updated",
  "issue.approval_linked",
  "issue.work_product_created",
  "issue.work_product_updated",
  "issue.work_product_deleted",
  "issue.document_deleted",
  "issue.attachment_added",
  "issue.attachment_removed",
  "heartbeat.cancelled",
  "heartbeat.retried",
] as const;

const ACTIONABLE_APPROVAL_STATUSES = new Set(["pending"]);
const DEFAULT_THREAD_SUMMARY_LIMIT = 40;
const MAX_THREAD_SUMMARY_LIMIT = 100;
const DEFAULT_ISSUE_THREAD_DETAIL_LIMIT = 50;
const MAX_ISSUE_THREAD_DETAIL_LIMIT = 100;
const FAILED_RUN_USER_SUMMARY =
  "The run hit a system-level execution problem. Rudder saved the technical details for diagnostics.";
type ThreadStateRow = typeof messengerThreadUserStates.$inferSelect;
type ThreadReadState = {
  lastReadAt: Date;
};
type ThreadStateMap = Map<string, ThreadStateRow>;
type ThreadStateSource = ThreadStateMap | Promise<ThreadStateMap>;
type SystemSummaryData = {
  summary: MessengerThreadSummary;
  itemCount: number;
};
type IssueThreadData = SystemSummaryData & {
  detail?: MessengerThreadDetail<MessengerIssueThreadItem>;
};
type IssueThreadDetailOptions = {
  includeDetail: boolean;
  limit?: number;
  cursor?: string | null;
};
type IssueThreadCursor = {
  activityAt: string;
  issueId: string;
};
type ThreadSummaryCursor = {
  activityAt: string;
  title: string;
  threadKey: string;
};
type IssueThreadEntry = {
  issue: IssueUniverseRow & { followed: boolean; assigned: boolean };
  latestActivityAt: Date;
  latestActivity: IssueActivityRow | null;
  attentionActivityAt: Date | null;
  attentionPreview: string | null;
};
type IssueThreadStats = {
  itemCount: number;
  unreadCount: number;
  latestActivityAt: Date | null;
};
type IssueThreadEntryRow = IssueUniverseRow & {
  followed: boolean;
  assigned: boolean;
  latestActivityAt: Date;
  latestActivityId: string | null;
  latestActivityAction: string | null;
  latestActivityActorType: string | null;
  latestActivityActorId: string | null;
  latestActivityDetails: Record<string, unknown> | null;
  latestActivityCreatedAt: Date | null;
  latestActivityRunId: string | null;
  attentionActivityAt: Date | null;
  latestExternalCommentBody: string | null;
  latestExternalCommentCreatedAt: Date | null;
  latestExternalActivityId: string | null;
  latestExternalActivityAction: string | null;
  latestExternalActivityActorType: string | null;
  latestExternalActivityActorId: string | null;
  latestExternalActivityDetails: Record<string, unknown> | null;
  latestExternalActivityCreatedAt: Date | null;
  latestExternalActivityRunId: string | null;
};

type IssueUniverseRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  reviewerUserId: string | null;
  createdByUserId: string | null;
  identifier: string | null;
  updatedAt: Date;
};

type IssueCommentRow = {
  id: string;
  issueId: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorAgentName: string | null;
  authorUserName: string | null;
  createdAt: Date;
};

type IssueActivityRow = {
  id: string;
  action: string;
  entityId: string;
  actorType: string;
  actorId: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
  runId: string | null;
};

type IssueStatusChange = {
  from: string | null;
  to: string;
};

type ApprovalRow = {
  id: string;
  orgId: string;
  type: string;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: string;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type BudgetIncidentRow = {
  id: string;
  orgId: string;
  policyId: string;
  scopeType: string;
  scopeId: string;
  scopeName?: string | null;
  metric: string;
  windowKind: string;
  windowStart: Date;
  windowEnd: Date;
  thresholdType: string;
  amountLimit: number;
  amountObserved: number;
  status: string;
  approvalStatus?: string | null;
  approvalId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type JoinRequestRow = {
  id: string;
  inviteId: string;
  orgId: string;
  requestType: string;
  status: string;
  requestIp: string;
  requestingUserId: string | null;
  requestEmailSnapshot: string | null;
  agentName: string | null;
  agentRuntimeType: string | null;
  capabilities: string | null;
  agentDefaultsPayload: Record<string, unknown> | null;
  claimSecretHash: string | null;
  claimSecretExpiresAt: Date | null;
  claimSecretConsumedAt: Date | null;
  createdAgentId: string | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  rejectedByUserId: string | null;
  rejectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ChatConversationRow = Awaited<ReturnType<ReturnType<typeof chatService>["list"]>>[number];
type ChatSummarySource = Pick<
  ChatConversationRow,
  "id" | "title" | "summary" | "latestReplyPreview" | "lastMessageAt" | "updatedAt" | "lastReadAt" | "unreadCount" | "needsAttention" | "isPinned"
>;
type ChatMessageRow = Awaited<ReturnType<ReturnType<typeof chatService>["listMessages"]>>[number];
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;

type ApprovalCommentRow = {
  approvalId: string;
  body: string;
  createdAt: Date;
};

type FailedRunRow = {
  id: string;
  orgId: string;
  agentId: string;
  status: string;
  error: string | null;
  stderrExcerpt: string | null;
  stdoutExcerpt: string | null;
  contextSnapshot: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

function truncate(value: string | null | undefined, max = 140): string | null {
  return formatMessengerPreview(value, { max });
}

function normalizeDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function maxDate(...values: Array<Date | string | null | undefined>) {
  const dates = values.map(normalizeDate).filter((value): value is Date => Boolean(value));
  if (dates.length === 0) return null;
  return dates.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
}

function compareLatestActivity<T extends { latestActivityAt: Date | null; title: string; threadKey?: string }>(a: T, b: T) {
  const aTime = a.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bTime = b.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return bTime - aTime;
  const titleDiff = a.title.localeCompare(b.title);
  if (titleDiff !== 0) return titleDiff;
  return (a.threadKey ?? "").localeCompare(b.threadKey ?? "");
}

function compareChronologicalActivity<T extends { latestActivityAt: Date | null; title: string }>(a: T, b: T) {
  const aTime = a.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bTime = b.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return a.title.localeCompare(b.title);
}

function normalizeIssueThreadLimit(limit: number | null | undefined) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_ISSUE_THREAD_DETAIL_LIMIT;
  return Math.min(MAX_ISSUE_THREAD_DETAIL_LIMIT, Math.max(1, Math.floor(limit)));
}

function normalizeThreadSummaryLimit(limit: number | null | undefined) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_THREAD_SUMMARY_LIMIT;
  return Math.min(MAX_THREAD_SUMMARY_LIMIT, Math.max(1, Math.floor(limit)));
}

function encodeThreadSummaryCursor(summary: MessengerThreadSummary) {
  const payload: ThreadSummaryCursor = {
    activityAt: (normalizeDate(summary.latestActivityAt) ?? new Date(0)).toISOString(),
    title: summary.title,
    threadKey: summary.threadKey,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeThreadSummaryCursor(cursor: string | null | undefined): ThreadSummaryCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ThreadSummaryCursor>;
    if (typeof decoded.activityAt !== "string" || Number.isNaN(new Date(decoded.activityAt).getTime())) return null;
    if (typeof decoded.title !== "string") return null;
    if (typeof decoded.threadKey !== "string" || decoded.threadKey.length === 0) return null;
    return {
      activityAt: decoded.activityAt,
      title: decoded.title,
      threadKey: decoded.threadKey,
    };
  } catch {
    return null;
  }
}

function threadSummaryIsAfterCursor(summary: MessengerThreadSummary, cursor: ThreadSummaryCursor | null) {
  if (!cursor) return true;
  const summaryTime = normalizeDate(summary.latestActivityAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const cursorTime = new Date(cursor.activityAt).getTime();
  if (summaryTime !== cursorTime) return summaryTime < cursorTime;
  const titleDiff = summary.title.localeCompare(cursor.title);
  if (titleDiff !== 0) return titleDiff > 0;
  return summary.threadKey.localeCompare(cursor.threadKey) > 0;
}

function threadSummaryPageInfo(limit: number, items: MessengerThreadSummary[], hasMore: boolean): MessengerThreadPageInfo {
  return {
    limit,
    nextCursor: hasMore && items.length > 0 ? encodeThreadSummaryCursor(items[items.length - 1]!) : null,
    hasMore,
  };
}

function encodeIssueThreadCursor(entry: IssueThreadEntry) {
  const payload: IssueThreadCursor = {
    activityAt: entry.latestActivityAt.toISOString(),
    issueId: entry.issue.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeIssueThreadCursor(cursor: string | null | undefined): IssueThreadCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<IssueThreadCursor>;
    if (typeof decoded.activityAt !== "string" || Number.isNaN(new Date(decoded.activityAt).getTime())) return null;
    if (typeof decoded.issueId !== "string" || decoded.issueId.length === 0) return null;
    return { activityAt: decoded.activityAt, issueId: decoded.issueId };
  } catch {
    return null;
  }
}

function compareIssueThreadEntriesChronological(a: IssueThreadEntry, b: IssueThreadEntry) {
  const aTime = a.latestActivityAt.getTime();
  const bTime = b.latestActivityAt.getTime();
  if (aTime !== bTime) return aTime - bTime;
  return a.issue.id.localeCompare(b.issue.id);
}

function threadKeyForChat(conversationId: string) {
  return `chat:${conversationId}`;
}

function buildAction(label: string, href: string | null, method: MessengerThreadAction["method"] = null): MessengerThreadAction {
  return { label, href, method };
}

function issueHref(issue: IssueUniverseRow) {
  return `/issues/${issue.identifier ?? issue.id}`;
}

function issueDisplayLabel(issue: IssueUniverseRow) {
  return issue.identifier ? `${issue.identifier} · ${issue.title}` : issue.title;
}

function issueThreadPreview(issue: IssueUniverseRow, preview: string | null) {
  const label = issueDisplayLabel(issue);
  const normalizedPreview = truncate(preview, 120);
  if (!normalizedPreview || normalizedPreview === label) return truncate(label, 180);
  return truncate(`${label} — ${normalizedPreview}`, 180);
}

function humanizeIssueStatus(status: string) {
  return status.replaceAll("_", " ");
}

function issueStatusChangeFromActivity(activity: IssueActivityRow | null | undefined): IssueStatusChange | null {
  if (!activity || activity.action !== "issue.updated") return null;
  const details = activity.details ?? {};
  if (typeof details.status !== "string") return null;

  const previous = details._previous && typeof details._previous === "object"
    ? details._previous as Record<string, unknown>
    : null;
  const from = typeof previous?.status === "string" ? previous.status : null;
  return { from, to: details.status };
}

function issueStatusActivityMatchesSourceComment(
  activity: IssueActivityRow | null | undefined,
  sourceComment: Pick<IssueCommentRow, "createdAt"> | null | undefined,
) {
  if (!activity || !sourceComment) return false;
  const details = activity.details ?? {};
  if (details.source !== "comment") return false;
  if (!issueStatusChangeFromActivity(activity)) return false;

  const activityAt = normalizeDate(activity.createdAt)?.getTime();
  const commentAt = normalizeDate(sourceComment.createdAt)?.getTime();
  if (activityAt === undefined || commentAt === undefined) return false;
  return Math.abs(commentAt - activityAt) <= 5_000;
}

function issueBodyFromSnapshot(
  issue: IssueUniverseRow,
  latestPreview: string | null,
  followed: boolean,
  created: boolean,
  assigned: boolean,
  reviewer: boolean,
) {
  const flags: string[] = [];
  if (followed) flags.push("followed");
  if (created) flags.push("created by me");
  if (assigned) flags.push("assigned to me");
  if (reviewer) flags.push("review requested");
  const status = issue.status.replaceAll("_", " ");
  const priority = issue.priority.replaceAll("_", " ");
  const prefix = [status, priority].filter(Boolean).join(" · ");
  const suffix = flags.length > 0 ? ` · ${flags.join(" · ")}` : "";
  return latestPreview ?? `${prefix}${suffix}`;
}

function summarizeIssueActivity(activity: IssueActivityRow, issue: IssueUniverseRow) {
  const details = activity.details ?? {};
  switch (activity.action) {
    case "issue.updated": {
      if (typeof details.status === "string") {
        const status = humanizeIssueStatus(details.status);
        if (details.status === "done") return "Completed";
        if (details.status === "cancelled") return "Cancelled";
        return `Status changed to ${status}`;
      }
      if (typeof details.assigneeUserId !== "undefined" || typeof details.assigneeAgentId !== "undefined") {
        return "Assignment changed";
      }
      if (typeof details.reviewerUserId !== "undefined" || typeof details.reviewerAgentId !== "undefined") {
        return "Reviewer changed";
      }
      return "Issue updated";
    }
    case "issue.approval_linked":
      return "Approval linked";
    case "issue.work_product_created":
      return "Work product created";
    case "issue.work_product_updated":
      return "Work product updated";
    case "issue.work_product_deleted":
      return "Work product removed";
    case "issue.attachment_added":
      return "Attachment added";
    case "issue.attachment_removed":
      return "Attachment removed";
    case "issue.document_deleted":
      return "Document removed";
    case "heartbeat.cancelled":
      return "Run cancelled";
    case "heartbeat.retried":
      return "Run retried";
    default:
      return `${issue.title} updated`;
  }
}

function issueCommentAuthorLabel(
  comment: Pick<IssueCommentRow, "authorAgentId" | "authorUserId" | "authorAgentName" | "authorUserName"> | null,
  currentUserId: string | null,
) {
  if (!comment) return null;
  if (comment.authorAgentId) return comment.authorAgentName?.trim() || `Agent ${comment.authorAgentId.slice(0, 8)}`;
  if (comment.authorUserId) {
    if (currentUserId && comment.authorUserId === currentUserId) return "You";
    return comment.authorUserName?.trim() || `User ${comment.authorUserId.slice(0, 8)}`;
  }
  return "System";
}

function summarizeApprovalPayload(approval: ApprovalRow) {
  const payload = redactEventPayload(approval.payload);
  if (!payload) return null;
  if (approval.type === "chat_issue_creation") {
    const proposal =
      payload.proposedIssue &&
      typeof payload.proposedIssue === "object" &&
      !Array.isArray(payload.proposedIssue)
        ? (payload.proposedIssue as Record<string, unknown>)
        : payload;
    const title = typeof proposal.title === "string" && proposal.title.trim() ? proposal.title.trim() : null;
    const description =
      typeof proposal.description === "string" && proposal.description.trim()
        ? truncate(proposal.description.trim(), 120)
        : null;
    return [title ? `Issue: ${title}` : "Agent proposed an issue from chat", description]
      .filter(Boolean)
      .join(" · ");
  }
  if (approval.type === "chat_operation") {
    const proposal =
      payload.operationProposal &&
      typeof payload.operationProposal === "object" &&
      !Array.isArray(payload.operationProposal)
        ? (payload.operationProposal as Record<string, unknown>)
        : payload;
    const summary = typeof proposal.summary === "string" && proposal.summary.trim() ? proposal.summary.trim() : null;
    return summary ? `Operation: ${truncate(summary, 120)}` : "Agent proposed a chat operation";
  }
  if (approval.type === "hire_agent") {
    const name = typeof payload.name === "string" ? payload.name : null;
    const role = typeof payload.role === "string" ? payload.role : null;
    if (name || role) {
      return [name, role].filter(Boolean).join(" · ");
    }
  }
  if (approval.type === "budget_override_required") {
    const scopeName = typeof payload.scopeName === "string" ? payload.scopeName : null;
    const budgetAmount = typeof payload.budgetAmount === "number" ? `$${(payload.budgetAmount / 100).toFixed(2)}` : null;
    return [scopeName, budgetAmount].filter(Boolean).join(" · ");
  }
  return Object.entries(payload)
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

function approvalRequesterLabel(approval: ApprovalRow, currentUserId: string | null) {
  if (approval.requestedByUserId && approval.requestedByUserId === currentUserId) return "You";
  if (approval.requestedByUserId) return "User";
  if (approval.requestedByAgentId) return "Agent";
  return "System";
}

function approvalActions(approval: ApprovalRow) {
  return [
    buildAction("Approve", `/approvals/${approval.id}/approve`, "POST"),
    buildAction("Reject", `/approvals/${approval.id}/reject`, "POST"),
    buildAction("Request changes", `/approvals/${approval.id}/request-revision`, "POST"),
    buildAction("Expand details", `/messenger/approvals/${approval.id}`, "GET"),
    buildAction("Open full approval", `/messenger/approvals/${approval.id}`, "GET"),
  ];
}

function issueActions(issue: IssueUniverseRow, currentUserId: string | null) {
  const actions: MessengerThreadAction[] = [
    buildAction("Open issue", issueHref(issue), "GET"),
    buildAction("Quick comment", `${issueHref(issue)}/comments`, "POST"),
  ];
  return actions;
}

function chatSummary(conversation: ChatSummarySource): MessengerThreadSummary {
  const preview =
    conversation.latestReplyPreview ?? truncate(conversation.summary, 140) ?? truncate(conversation.title, 140) ?? "Start the conversation";
  return {
    threadKey: threadKeyForChat(conversation.id),
    kind: "chat",
    title: formatMessengerTitle(conversation.title, { max: 80 }) ?? conversation.title,
    subtitle: preview,
    preview,
    latestActivityAt: conversation.lastMessageAt ?? conversation.updatedAt,
    lastReadAt: conversation.lastReadAt,
    unreadCount: conversation.unreadCount,
    needsAttention: conversation.needsAttention,
    isPinned: conversation.isPinned,
    href: `/messenger/chat/${conversation.id}`,
  };
}

function issueSummary(
  issueCount: number,
  latestActivityAt: Date | null,
  unreadCount: number,
  lastReadAt: Date | null,
  preview: string | null,
): MessengerThreadSummary {
  return {
    threadKey: "issues",
    kind: "issues",
    title: "Issues",
    subtitle: issueCount > 0 ? `${issueCount} tracked issue${issueCount === 1 ? "" : "s"}` : "No tracked issues yet",
    preview: issueCount > 0 ? preview ?? "Cross-issue activity feed" : "Create or follow issues to populate this feed",
    latestActivityAt,
    lastReadAt,
    unreadCount,
    needsAttention: unreadCount > 0,
    isPinned: false,
    href: "/messenger/issues",
  };
}

function approvalSummary(
  approvalCount: number,
  latestActivityAt: Date | null,
  unreadCount: number,
  lastReadAt: Date | null,
  preview: string | null,
): MessengerThreadSummary {
  return {
    threadKey: "approvals",
    kind: "approvals",
    title: "Approvals",
    subtitle:
      approvalCount > 0
        ? `${approvalCount} approval${approvalCount === 1 ? "" : "s"}`
        : "No approvals yet",
    preview: approvalCount > 0 ? preview ?? "Review and decide on pending approvals" : "No approvals in this organization",
    latestActivityAt,
    lastReadAt,
    unreadCount,
    needsAttention: unreadCount > 0,
    isPinned: false,
    href: "/messenger/approvals",
  };
}

function systemSummary(
  kind: MessengerSystemThreadKind,
  title: string,
  itemCount: number,
  latestActivityAt: Date | null,
  unreadCount: number,
  lastReadAt: Date | null,
  subtitleWhenEmpty: string,
  preview: string | null,
): MessengerThreadSummary {
  return {
    threadKey: kind,
    kind,
    title,
    subtitle: itemCount > 0 ? `${itemCount} item${itemCount === 1 ? "" : "s"}` : subtitleWhenEmpty,
    preview: itemCount > 0 ? preview ?? "Aggregate operational updates" : subtitleWhenEmpty,
    latestActivityAt,
    lastReadAt,
    unreadCount,
    needsAttention: unreadCount > 0,
    isPinned: false,
    href: `/messenger/system/${kind}`,
  };
}

function issueCard(
  issue: IssueUniverseRow,
  currentUserId: string | null,
  followed: boolean,
  latestPreview: string | null,
  latestActivityAt: Date,
  sourceComment: Pick<IssueCommentRow, "id" | "body" | "authorAgentId" | "authorUserId" | "authorAgentName" | "authorUserName"> | null,
  latestActivity: IssueActivityRow | null,
): MessengerIssueThreadItem {
  const createdByMe = issue.createdByUserId === currentUserId;
  const assignedToMe = issue.assigneeUserId === currentUserId;
  const reviewerForMe = issue.reviewerUserId === currentUserId && issue.status === "in_review";
  const statusChange = issueStatusChangeFromActivity(latestActivity);
  const sourceCommentAuthorKind = sourceComment?.authorAgentId
    ? "agent"
    : sourceComment?.authorUserId ? "user" : "system";
  const sourceCommentByMe = Boolean(sourceComment?.authorUserId && sourceComment.authorUserId === currentUserId);
  const sourceCommentAuthorLabel = issueCommentAuthorLabel(sourceComment, currentUserId);
  return {
    id: issue.id,
    threadKey: "issues",
    kind: "issues",
    title: issueDisplayLabel(issue),
    subtitle: issueBodyFromSnapshot(issue, latestPreview, followed, createdByMe, assignedToMe, reviewerForMe),
    body: issueBodyFromSnapshot(issue, latestPreview, followed, createdByMe, assignedToMe, reviewerForMe),
    preview: latestPreview,
    href: issueHref(issue),
    latestActivityAt,
    actions: issueActions(issue, currentUserId),
    metadata: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      status: issue.status,
      ...(statusChange ? { statusChange } : {}),
      priority: issue.priority,
      followed,
      createdByMe,
      assignedToMe,
      reviewerForMe,
      ...(sourceComment
        ? {
          sourceCommentAuthorKind,
          sourceCommentByMe,
          sourceCommentAuthorLabel,
        }
        : {}),
    },
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    sourceCommentId: sourceComment?.id ?? null,
    sourceCommentAuthorLabel,
    sourceCommentBody: sourceComment?.body ?? null,
  };
}

function approvalCard(
  approval: ApprovalRow,
  latestComment: ApprovalCommentRow | null,
  currentUserId: string | null,
  latestActivityAt: Date,
): MessengerApprovalThreadItem {
  const payloadPreview = summarizeApprovalPayload(approval);
  const body = latestComment ? truncate(latestComment.body) : approval.decisionNote ?? payloadPreview;
  const title =
    approval.type === "chat_issue_creation"
      ? "Review proposed issue"
      : approval.type === "chat_operation"
        ? "Review chat operation"
        : approval.type.replaceAll("_", " ");
  return {
    id: approval.id,
    threadKey: "approvals",
    kind: "approvals",
    title,
    subtitle: `${approvalRequesterLabel(approval, currentUserId)} · ${approval.status.replaceAll("_", " ")}`,
    body,
    preview: body,
    href: `/messenger/approvals/${approval.id}`,
    latestActivityAt,
    actions: approvalActions(approval),
    metadata: {
      approvalId: approval.id,
      type: approval.type,
      status: approval.status,
      payload: redactEventPayload(approval.payload),
      requester: approvalRequesterLabel(approval, currentUserId),
    },
    approval: approval as Approval,
  };
}

function failedRunCard(run: FailedRunRow, agentName: string | null): MessengerHeartbeatRunThreadItem {
  return {
    id: run.id,
    threadKey: "failed-runs",
    kind: "failed-runs",
    title: agentName ? `${agentName} · Failed run` : "Failed run",
    subtitle: run.status.replaceAll("_", " "),
    body: FAILED_RUN_USER_SUMMARY,
    preview: FAILED_RUN_USER_SUMMARY,
    href: `/agents/${run.agentId}/runs/${run.id}`,
    latestActivityAt: run.updatedAt ?? run.createdAt,
    actions: [
      buildAction("Retry", `/heartbeat-runs/${run.id}/retry`, "POST"),
      buildAction("Open run", `/agents/${run.agentId}/runs/${run.id}`, "GET"),
    ],
    metadata: {
      runId: run.id,
      agentId: run.agentId,
      status: run.status,
      contextSnapshot: run.contextSnapshot,
    },
    run: run as HeartbeatRun,
  };
}

function budgetCard(incident: BudgetIncidentRow): MessengerBudgetThreadItem {
  return {
    id: incident.id,
    threadKey: "budget-alerts",
    kind: "budget-alerts",
    title: incident.scopeName || "Budget alert",
    subtitle: `${incident.scopeType} · ${incident.thresholdType}`,
    body: `${incident.metric.replaceAll("_", " ")} ${incident.amountObserved} / ${incident.amountLimit}`,
    preview: `${incident.amountObserved} observed against ${incident.amountLimit} limit`,
    href: "/costs",
    latestActivityAt: incident.updatedAt ?? incident.createdAt,
    actions: [buildAction("Open budget", "/costs", "GET")],
    metadata: {
      incidentId: incident.id,
      scopeType: incident.scopeType,
      scopeId: incident.scopeId,
      status: incident.status,
      thresholdType: incident.thresholdType,
    },
    incident: incident as BudgetIncident,
  };
}

function joinRequestCard(request: JoinRequestRow): MessengerJoinRequestThreadItem {
  const title = request.agentName ?? request.requestEmailSnapshot ?? request.requestType.replaceAll("_", " ");
  return {
    id: request.id,
    threadKey: "join-requests",
    kind: "join-requests",
    title,
    subtitle: `${request.status.replaceAll("_", " ")} · ${request.requestType.replaceAll("_", " ")}`,
    body: (request.capabilities ?? request.agentDefaultsPayload)
      ? "Join request needs approval"
      : "Join request",
    preview: request.capabilities ?? request.requestEmailSnapshot ?? null,
    href: null,
    latestActivityAt: request.updatedAt ?? request.createdAt,
    actions: [
      buildAction("Approve", `/orgs/${request.orgId}/join-requests/${request.id}/approve`, "POST"),
      buildAction("Reject", `/orgs/${request.orgId}/join-requests/${request.id}/reject`, "POST"),
    ],
    metadata: {
      requestId: request.id,
      orgId: request.orgId,
      requestType: request.requestType,
      status: request.status,
    },
    joinRequest: request as JoinRequest,
  };
}

function systemUnreadCountSince<T extends { updatedAt: Date | null; createdAt?: Date | null }>(
  rows: T[],
  lastReadAt: Date | null,
): number {
  if (!lastReadAt) return rows.length;
  return rows.filter((row) => {
    const activityAt = normalizeDate(row.updatedAt ?? row.createdAt ?? null);
    return Boolean(activityAt && activityAt.getTime() > lastReadAt.getTime());
  }).length;
}

async function loadThreadStates(db: Db, orgId: string, userId: string, threadKeys: string[]) {
  if (threadKeys.length === 0) return new Map<string, ThreadStateRow>();
  const rows = await db
    .select()
    .from(messengerThreadUserStates)
    .where(and(eq(messengerThreadUserStates.orgId, orgId), eq(messengerThreadUserStates.userId, userId), inArray(messengerThreadUserStates.threadKey, threadKeys)));
  return new Map<string, ThreadStateRow>(rows.map((row) => [row.threadKey, row]));
}

async function lastReadAtForThread(
  db: Db,
  orgId: string,
  userId: string,
  threadKey: string,
  threadStates?: ThreadStateSource,
) {
  const states = threadStates ?? loadThreadStates(db, orgId, userId, [threadKey]);
  return (await states).get(threadKey)?.lastReadAt ?? null;
}

export function messengerService(db: Db) {
  const chatsSvc = chatService(db);
  const budgetsSvc = budgetService(db);

  const issueActionSqlList = sql.join(ISSUE_ACTIVITY_ACTIONS.map((action) => sql`${action}`), sql`, `);

  function issueDescriptionOnlyActivitySql(alias: string) {
    return sql<boolean>`(
      ${sql.raw(`${alias}.action`)} = 'issue.updated'
      and jsonb_typeof(${sql.raw(`${alias}.details`)}) = 'object'
      and ${sql.raw(`${alias}.details`)} ? 'description'
      and not exists (
        select 1
        from jsonb_object_keys(${sql.raw(`${alias}.details`)}) as detail_key(key)
        where detail_key.key not in (
          'description',
          'identifier',
          'issueIdentifier',
          '_previous',
          'source',
          'reopened',
          'reopenedFrom',
          'normalizedFromStatus',
          'normalizedReason'
        )
      )
    )`;
  }

  function issueEntryRowsQuery(orgId: string, userId: string, tail = sql``) {
    const descriptionOnlyActivity = issueDescriptionOnlyActivitySql("activity_row");
    const externalDescriptionOnlyActivity = issueDescriptionOnlyActivitySql("external_activity_row");
    return sql<IssueThreadEntryRow>`
      with tracked_issue_ids as (
        select ${issues.id} as id
        from ${issues}
        where ${issues.orgId} = ${orgId}
          and ${issues.hiddenAt} is null
          and ${issues.assigneeUserId} = ${userId}
        union
        select ${issues.id} as id
        from ${issues}
        where ${issues.orgId} = ${orgId}
          and ${issues.hiddenAt} is null
          and ${issues.createdByUserId} = ${userId}
        union
        select ${issues.id} as id
        from ${issues}
        where ${issues.orgId} = ${orgId}
          and ${issues.hiddenAt} is null
          and ${issues.reviewerUserId} = ${userId}
        union
        select ${issueFollows.issueId} as id
        from ${issueFollows}
        inner join ${issues} followed_issue
          on followed_issue.id = ${issueFollows.issueId}
          and followed_issue.org_id = ${issueFollows.orgId}
        where ${issueFollows.orgId} = ${orgId}
          and ${issueFollows.userId} = ${userId}
          and followed_issue.hidden_at is null
      ),
      issue_entries as (
        select
          issue_row.id as id,
          issue_row.title as title,
          issue_row.status as status,
          issue_row.priority as priority,
          issue_row.assignee_user_id as "assigneeUserId",
          issue_row.reviewer_user_id as "reviewerUserId",
          issue_row.created_by_user_id as "createdByUserId",
          issue_row.identifier as identifier,
          issue_row.updated_at as "updatedAt",
          exists (
            select 1
            from ${issueFollows} follow_row
            where follow_row.org_id = ${orgId}
              and follow_row.user_id = ${userId}
              and follow_row.issue_id = issue_row.id
          ) as followed,
          (issue_row.assignee_user_id = ${userId}) as assigned,
          greatest(
            issue_row.updated_at,
            coalesce(latest_external_comment.created_at, issue_row.updated_at),
            coalesce(latest_activity.created_at, issue_row.updated_at)
          ) as "latestActivityAt",
          latest_activity.id as "latestActivityId",
          latest_activity.action as "latestActivityAction",
          latest_activity.actor_type as "latestActivityActorType",
          latest_activity.actor_id as "latestActivityActorId",
          latest_activity.details as "latestActivityDetails",
          latest_activity.created_at as "latestActivityCreatedAt",
          latest_activity.run_id as "latestActivityRunId",
          case
            when latest_external_comment.created_at is not null
              and (latest_external_activity.created_at is null or latest_external_comment.created_at >= latest_external_activity.created_at)
              then latest_external_comment.created_at
            when latest_external_activity.created_at is not null
              then latest_external_activity.created_at
            when latest_activity.id is null
              and (
                latest_suppressed_activity.created_at is null
                or latest_suppressed_activity.created_at < issue_row.updated_at - interval '5 seconds'
              )
              and (
                issue_row.assignee_user_id = ${userId}
                or (issue_row.reviewer_user_id = ${userId} and issue_row.status = 'in_review')
              )
              then issue_row.updated_at
            else null
          end as "attentionActivityAt",
          latest_external_comment.body as "latestExternalCommentBody",
          latest_external_comment.created_at as "latestExternalCommentCreatedAt",
          latest_external_activity.id as "latestExternalActivityId",
          latest_external_activity.action as "latestExternalActivityAction",
          latest_external_activity.actor_type as "latestExternalActivityActorType",
          latest_external_activity.actor_id as "latestExternalActivityActorId",
          latest_external_activity.details as "latestExternalActivityDetails",
          latest_external_activity.created_at as "latestExternalActivityCreatedAt",
          latest_external_activity.run_id as "latestExternalActivityRunId"
        from tracked_issue_ids
        inner join ${issues} issue_row on issue_row.id = tracked_issue_ids.id
        left join lateral (
          select
            comment_row.body,
            comment_row.created_at
          from ${issueComments} comment_row
          where comment_row.org_id = ${orgId}
            and comment_row.issue_id = issue_row.id
            and (comment_row.author_user_id is null or comment_row.author_user_id <> ${userId})
          order by comment_row.created_at desc, comment_row.id desc
          limit 1
        ) latest_external_comment on true
        left join lateral (
          select
            activity_row.id,
            activity_row.action,
            activity_row.actor_type,
            activity_row.actor_id,
            activity_row.details,
            activity_row.created_at,
            activity_row.run_id
          from ${activityLog} activity_row
          where activity_row.org_id = ${orgId}
            and activity_row.entity_type = 'issue'
            and activity_row.entity_id = issue_row.id::text
            and activity_row.action in (${issueActionSqlList})
            and not ${descriptionOnlyActivity}
          order by activity_row.created_at desc, activity_row.id desc
          limit 1
        ) latest_activity on true
        left join lateral (
          select
            external_activity_row.id,
            external_activity_row.action,
            external_activity_row.actor_type,
            external_activity_row.actor_id,
            external_activity_row.details,
            external_activity_row.created_at,
            external_activity_row.run_id
          from ${activityLog} external_activity_row
          where external_activity_row.org_id = ${orgId}
            and external_activity_row.entity_type = 'issue'
            and external_activity_row.entity_id = issue_row.id::text
            and external_activity_row.action in (${issueActionSqlList})
            and not ${externalDescriptionOnlyActivity}
            and (external_activity_row.actor_type <> 'user' or external_activity_row.actor_id <> ${userId})
          order by external_activity_row.created_at desc, external_activity_row.id desc
          limit 1
        ) latest_external_activity on true
        left join lateral (
          select suppressed_activity_row.created_at
          from ${activityLog} suppressed_activity_row
          where suppressed_activity_row.org_id = ${orgId}
            and suppressed_activity_row.entity_type = 'issue'
            and suppressed_activity_row.entity_id = issue_row.id::text
            and suppressed_activity_row.action in (${issueActionSqlList})
            and ${issueDescriptionOnlyActivitySql("suppressed_activity_row")}
          order by suppressed_activity_row.created_at desc, suppressed_activity_row.id desc
          limit 1
        ) latest_suppressed_activity on true
      )
      select *
      from issue_entries
      ${tail}
    `;
  }

  async function loadLatestIssueCommentsForDisplay(orgId: string, issueIds: string[], userId: string) {
    if (issueIds.length === 0) return [] as IssueCommentRow[];
    return (await db
      .selectDistinctOn([issueComments.issueId], {
        id: issueComments.id,
        issueId: issueComments.issueId,
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        authorAgentName: agents.name,
        authorUserName: authUsers.name,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .leftJoin(agents, eq(issueComments.authorAgentId, agents.id))
      .leftJoin(authUsers, eq(issueComments.authorUserId, authUsers.id))
      .where(and(
        eq(issueComments.orgId, orgId),
        inArray(issueComments.issueId, issueIds),
        or(isNull(issueComments.authorUserId), ne(issueComments.authorUserId, userId)),
      ))
      .orderBy(issueComments.issueId, desc(issueComments.createdAt), desc(issueComments.id))) as IssueCommentRow[];
  }

  function issueThreadEntryFromRow(row: IssueThreadEntryRow, userId: string): IssueThreadEntry {
    const updatedAt = normalizeDate(row.updatedAt) ?? new Date(row.updatedAt);
    const latestActivityAt = normalizeDate(row.latestActivityAt) ?? updatedAt;
    const latestActivityCreatedAt = normalizeDate(row.latestActivityCreatedAt);
    const latestExternalActivityCreatedAt = normalizeDate(row.latestExternalActivityCreatedAt);
    const issue = {
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      assigneeUserId: row.assigneeUserId,
      reviewerUserId: row.reviewerUserId,
      createdByUserId: row.createdByUserId,
      identifier: row.identifier,
      updatedAt,
      followed: row.followed,
      assigned: row.assigned,
    };
    const latestActivity = row.latestActivityId && row.latestActivityAction && row.latestActivityActorType && row.latestActivityActorId && latestActivityCreatedAt
      ? {
        id: row.latestActivityId,
        action: row.latestActivityAction,
        entityId: row.id,
        actorType: row.latestActivityActorType,
        actorId: row.latestActivityActorId,
        details: row.latestActivityDetails,
        createdAt: latestActivityCreatedAt,
        runId: row.latestActivityRunId,
      }
      : null;
    const latestExternalActivity =
      row.latestExternalActivityId &&
      row.latestExternalActivityAction &&
      row.latestExternalActivityActorType &&
      row.latestExternalActivityActorId &&
      latestExternalActivityCreatedAt
        ? {
          id: row.latestExternalActivityId,
          action: row.latestExternalActivityAction,
          entityId: row.id,
          actorType: row.latestExternalActivityActorType,
          actorId: row.latestExternalActivityActorId,
          details: row.latestExternalActivityDetails,
          createdAt: latestExternalActivityCreatedAt,
          runId: row.latestExternalActivityRunId,
        }
        : null;
    const latestExternalCommentAt = normalizeDate(row.latestExternalCommentCreatedAt);
    const attentionActivityAt = normalizeDate(row.attentionActivityAt);
    const latestExternalActivityAt = normalizeDate(latestExternalActivity?.createdAt ?? null);
    const attentionPreview =
      latestExternalCommentAt &&
      (!latestExternalActivityAt || latestExternalCommentAt.getTime() >= latestExternalActivityAt.getTime())
        ? truncate(row.latestExternalCommentBody)
        : latestExternalActivity
          ? summarizeIssueActivity(latestExternalActivity, issue)
          : null;
    const fallbackPreview = attentionPreview
      ?? (attentionActivityAt
        ? issueBodyFromSnapshot(
          issue,
          null,
          row.followed,
          row.createdByUserId === userId,
          row.assigneeUserId === userId,
          row.reviewerUserId === userId && row.status === "in_review",
        )
        : null);

    return {
      issue,
      latestActivityAt,
      latestActivity,
      attentionActivityAt,
      attentionPreview: attentionActivityAt ? issueThreadPreview(issue, fallbackPreview) : null,
    };
  }

  async function loadIssueThreadStats(orgId: string, userId: string, lastReadAt: Date | null): Promise<IssueThreadStats> {
    const lastReadAtIso = lastReadAt?.toISOString() ?? null;
    const rows = (await db.execute(sql<IssueThreadStats>`
      select
        count(*)::int as "itemCount",
        count(*) filter (
          where "attentionActivityAt" is not null
            and (${lastReadAtIso}::timestamptz is null or "attentionActivityAt" > ${lastReadAtIso}::timestamptz)
        )::int as "unreadCount",
        max("attentionActivityAt") filter (
          where ${lastReadAtIso}::timestamptz is null or "attentionActivityAt" > ${lastReadAtIso}::timestamptz
        ) as "latestActivityAt"
      from (${issueEntryRowsQuery(orgId, userId)}) issue_entry_stats
    `)) as IssueThreadStats[];
    const row = rows[0];
    return row
      ? {
        itemCount: Number(row.itemCount),
        unreadCount: Number(row.unreadCount),
        latestActivityAt: normalizeDate(row.latestActivityAt),
      }
      : { itemCount: 0, unreadCount: 0, latestActivityAt: null };
  }

  async function loadLatestUnreadIssueEntry(orgId: string, userId: string, lastReadAt: Date | null) {
    const lastReadAtIso = lastReadAt?.toISOString() ?? null;
    const rows = (await db.execute(issueEntryRowsQuery(
      orgId,
      userId,
      sql`
        where "attentionActivityAt" is not null
          and (${lastReadAtIso}::timestamptz is null or "attentionActivityAt" > ${lastReadAtIso}::timestamptz)
        order by "attentionActivityAt" desc, id asc
        limit 1
      `,
    ))) as IssueThreadEntryRow[];
    return rows[0] ? issueThreadEntryFromRow(rows[0], userId) : null;
  }

  async function loadIssueDetailEntries(
    orgId: string,
    userId: string,
    limit: number,
    cursor: IssueThreadCursor | null,
  ) {
    const cursorActivityAt = cursor ? new Date(cursor.activityAt).toISOString() : null;
    const rows = (await db.execute(issueEntryRowsQuery(
      orgId,
      userId,
      sql`
        ${cursor
          ? sql`
            where (
              "latestActivityAt" < ${cursorActivityAt}::timestamptz
              or ("latestActivityAt" = ${cursorActivityAt}::timestamptz and id > ${cursor.issueId})
            )
          `
          : sql``}
        order by "latestActivityAt" desc, id asc
        limit ${limit + 1}
      `,
    ))) as IssueThreadEntryRow[];
    return rows.map((row) => issueThreadEntryFromRow(row, userId));
  }

  async function loadIssueData(
    orgId: string,
    userId: string,
    threadStates: ThreadStateSource | undefined,
    options: IssueThreadDetailOptions,
  ): Promise<IssueThreadData> {
    const lastReadAtPromise = lastReadAtForThread(db, orgId, userId, "issues", threadStates);
    const lastReadAt = await lastReadAtPromise;
    const detailLimit = normalizeIssueThreadLimit(options.limit);
    const decodedCursor = decodeIssueThreadCursor(options.cursor);
    if (options.cursor && !decodedCursor) {
      throw conflict("Messenger issues cursor is invalid or expired");
    }

    const [stats, latestAttentionEntry, detailEntries] = await Promise.all([
      loadIssueThreadStats(orgId, userId, lastReadAt),
      loadLatestUnreadIssueEntry(orgId, userId, lastReadAt),
      options.includeDetail
        ? loadIssueDetailEntries(orgId, userId, detailLimit, decodedCursor)
        : Promise.resolve([] as IssueThreadEntry[]),
    ]);
    const hasMoreDetailEntries = options.includeDetail && detailEntries.length > detailLimit;
    const pageEntries = hasMoreDetailEntries ? detailEntries.slice(0, detailLimit) : detailEntries;
    const cursorEntry = hasMoreDetailEntries ? pageEntries.at(-1) ?? null : null;
    const latestDisplayCommentRows = await loadLatestIssueCommentsForDisplay(orgId, pageEntries.map((entry) => entry.issue.id), userId);
    const latestDisplayCommentByIssue = new Map<string, IssueCommentRow>();
    for (const row of latestDisplayCommentRows) {
      latestDisplayCommentByIssue.set(row.issueId, row);
    }
    const chronologicalItems = pageEntries
      .sort(compareIssueThreadEntriesChronological)
      .map((entry) => {
        const latestDisplayComment = latestDisplayCommentByIssue.get(entry.issue.id) ?? null;
        const latestDisplayCommentAt = normalizeDate(latestDisplayComment?.createdAt ?? null);
        const latestSourceIsComment = Boolean(
          latestDisplayCommentAt &&
          (!entry.latestActivity?.createdAt || latestDisplayCommentAt.getTime() >= new Date(entry.latestActivity.createdAt).getTime()),
        );
        const sourceComment = latestSourceIsComment ? latestDisplayComment : null;
        const latestPreview = sourceComment
          ? truncate(sourceComment.body)
          : entry.latestActivity
            ? summarizeIssueActivity(entry.latestActivity, entry.issue)
            : null;
        const statusChangeActivity = sourceComment
          ? (issueStatusActivityMatchesSourceComment(entry.latestActivity, sourceComment) ? entry.latestActivity : null)
          : entry.latestActivity;
        return issueCard(
          entry.issue,
          userId,
          entry.issue.followed,
          latestPreview,
          entry.latestActivityAt,
          sourceComment,
          statusChangeActivity,
        );
      });

    const data: IssueThreadData = {
      summary: issueSummary(stats.itemCount, stats.latestActivityAt, stats.unreadCount, lastReadAt, latestAttentionEntry?.attentionPreview ?? null),
      itemCount: stats.itemCount,
    };
    if (options.includeDetail) {
      data.detail = {
        threadKey: "issues",
        kind: "issues",
        title: "Issues",
        subtitle: `${stats.itemCount} tracked issue${stats.itemCount === 1 ? "" : "s"}`,
        preview: latestAttentionEntry?.attentionPreview ?? null,
        latestActivityAt: stats.latestActivityAt,
        lastReadAt,
        unreadCount: stats.unreadCount,
        needsAttention: stats.unreadCount > 0,
        isPinned: false,
        href: "/messenger/issues",
        description: "Followed issues, issues I created, issues assigned to me, and issues ready for my review",
        items: chronologicalItems,
        pageInfo: {
          limit: detailLimit,
          nextCursor: cursorEntry ? encodeIssueThreadCursor(cursorEntry) : null,
          hasMore: hasMoreDetailEntries,
        },
      };
    }
    return data;
  }

  async function loadIssueSummaryData(
    orgId: string,
    userId: string,
    threadStates?: ThreadStateSource,
    options: Pick<IssueThreadDetailOptions, "limit" | "cursor"> = {},
  ) {
    const data = await loadIssueData(orgId, userId, threadStates, { includeDetail: true, ...options });
    return {
      summary: data.summary,
      detail: data.detail!,
    };
  }

  async function loadIssueThreadSummaryData(orgId: string, userId: string, threadStates?: ThreadStateSource): Promise<SystemSummaryData> {
    return loadIssueData(orgId, userId, threadStates, { includeDetail: false });
  }

  async function loadApprovalSummaryData(orgId: string, userId: string, threadStates?: ThreadStateSource) {
    const lastReadAtPromise = lastReadAtForThread(db, orgId, userId, "approvals", threadStates);

    const [approvalRows, latestComments] = await Promise.all([
      db
        .select()
        .from(approvals)
        .where(eq(approvals.orgId, orgId))
        .orderBy(desc(approvals.updatedAt), desc(approvals.createdAt)),
      db
        .select({
          approvalId: approvalComments.approvalId,
          body: approvalComments.body,
          createdAt: approvalComments.createdAt,
        })
        .from(approvalComments)
        .innerJoin(approvals, eq(approvalComments.approvalId, approvals.id))
        .where(eq(approvals.orgId, orgId))
        .orderBy(desc(approvalComments.createdAt)),
    ]);

    const lastReadAt = await lastReadAtPromise;
    const latestCommentByApproval = new Map<string, ApprovalCommentRow>();
    for (const row of latestComments) {
      if (!latestCommentByApproval.has(row.approvalId)) {
        latestCommentByApproval.set(row.approvalId, row);
      }
    }

    const typedApprovalRows = approvalRows as ApprovalRow[];
    const unsortedItems = typedApprovalRows.map((approval) => {
      const latestComment = latestCommentByApproval.get(approval.id) ?? null;
      const latestActivityAt = maxDate(approval.updatedAt, latestComment?.createdAt) ?? approval.updatedAt;
      return approvalCard(approval, latestComment, userId, latestActivityAt);
    });
    const latestFirstItems = [...unsortedItems].sort(compareLatestActivity);
    const chronologicalItems = [...unsortedItems].sort(compareChronologicalActivity);

    const actionable = typedApprovalRows.filter((approval) => ACTIONABLE_APPROVAL_STATUSES.has(approval.status));
    const unreadCount = actionable.filter((approval) => {
      const activityAt = normalizeDate(approval.updatedAt);
      if (!activityAt) return false;
      if (!lastReadAt) return true;
      return activityAt.getTime() > lastReadAt.getTime();
    }).length;
    const latestActivityAt = latestFirstItems[0]?.latestActivityAt ?? null;

    return {
      summary: approvalSummary(approvalRows.length, latestActivityAt, unreadCount, lastReadAt, latestFirstItems[0]?.preview ?? null),
      detail: {
        threadKey: "approvals",
        kind: "approvals",
        title: "Approvals",
        subtitle: `${approvalRows.length} approval${approvalRows.length === 1 ? "" : "s"}`,
        preview: latestFirstItems[0]?.preview ?? null,
        latestActivityAt,
        lastReadAt,
        unreadCount,
        needsAttention: unreadCount > 0,
        isPinned: false,
        href: "/messenger/approvals",
        description: "Approvals needing attention",
        items: chronologicalItems,
      } satisfies MessengerThreadDetail<MessengerApprovalThreadItem>,
    };
  }

  async function loadApprovalThreadSummaryData(orgId: string, userId: string, threadStates?: ThreadStateSource): Promise<SystemSummaryData> {
    const lastReadAt = await lastReadAtForThread(db, orgId, userId, "approvals", threadStates);
    const approvalPredicate = eq(approvals.orgId, orgId);
    const pendingApprovalPredicate = and(eq(approvals.orgId, orgId), eq(approvals.status, "pending"));

    const [summaryRows, latestApprovalRows, latestCommentRows, unreadRows] = await Promise.all([
      db
        .select({
          itemCount: sql<number>`count(*)::int`,
        })
        .from(approvals)
        .where(approvalPredicate),
      db
        .select()
        .from(approvals)
        .where(approvalPredicate)
        .orderBy(desc(approvals.updatedAt), desc(approvals.createdAt))
        .limit(1),
      db
        .execute(sql<ApprovalCommentRow>`
          select
            latest_comment.approval_id as "approvalId",
            latest_comment.body as "body",
            latest_comment.created_at as "createdAt"
          from ${approvals}
          inner join lateral (
            select
              ${approvalComments.approvalId},
              ${approvalComments.body},
              ${approvalComments.createdAt}
            from ${approvalComments}
            where ${approvalComments.orgId} = ${orgId}
              and ${approvalComments.approvalId} = ${approvals.id}
            order by ${approvalComments.createdAt} desc
            limit 1
          ) latest_comment on true
          where ${approvals.orgId} = ${orgId}
          order by latest_comment.created_at desc
          limit 1
        `),
      db
        .select({
          unreadCount: sql<number>`count(*)::int`,
        })
        .from(approvals)
        .where(lastReadAt ? and(pendingApprovalPredicate, gt(approvals.updatedAt, lastReadAt)) : pendingApprovalPredicate),
    ]);

    const latestApproval = (latestApprovalRows[0] ?? null) as ApprovalRow | null;
    const latestApprovalCommentRows = latestApproval
      ? await db
        .select({
          approvalId: approvalComments.approvalId,
          body: approvalComments.body,
          createdAt: approvalComments.createdAt,
        })
        .from(approvalComments)
        .where(eq(approvalComments.approvalId, latestApproval.id))
        .orderBy(desc(approvalComments.createdAt))
        .limit(1)
      : [];
    const latestCommentRow = (latestCommentRows[0] ?? null) as ApprovalCommentRow | null;
    const latestCommentApprovalRows = latestCommentRow
      ? await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, latestCommentRow.approvalId), approvalPredicate))
        .limit(1)
      : [];

    const candidateItems: MessengerApprovalThreadItem[] = [];
    if (latestApproval) {
      const latestComment = (latestApprovalCommentRows[0] ?? null) as ApprovalCommentRow | null;
      const latestActivityAt = maxDate(latestApproval.updatedAt, latestComment?.createdAt) ?? latestApproval.updatedAt;
      candidateItems.push(approvalCard(latestApproval, latestComment, userId, latestActivityAt));
    }
    if (latestCommentRow) {
      const approval = (latestCommentApprovalRows[0] ?? null) as ApprovalRow | null;
      if (approval) {
        const latestActivityAt = maxDate(approval.updatedAt, latestCommentRow.createdAt) ?? approval.updatedAt;
        candidateItems.push(approvalCard(approval, latestCommentRow, userId, latestActivityAt));
      }
    }

    const latestItem = candidateItems.sort(compareLatestActivity)[0] ?? null;
    const itemCount = Number(summaryRows[0]?.itemCount ?? 0);
    return {
      itemCount,
      summary: approvalSummary(
        itemCount,
        latestItem?.latestActivityAt ?? null,
        Number(unreadRows[0]?.unreadCount ?? 0),
        lastReadAt,
        latestItem?.preview ?? null,
      ),
    };
  }

  async function loadFailedRunData(orgId: string, userId: string, threadStates?: ThreadStateSource) {
    const lastReadAtPromise = lastReadAtForThread(db, orgId, userId, "failed-runs", threadStates);

    const [runRows, agentRows] = await Promise.all([
      db
        .select({
          id: heartbeatRuns.id,
          orgId: heartbeatRuns.orgId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          error: heartbeatRuns.error,
          stderrExcerpt: heartbeatRuns.stderrExcerpt,
          stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          createdAt: heartbeatRuns.createdAt,
          updatedAt: heartbeatRuns.updatedAt,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.orgId, orgId), eq(heartbeatRuns.status, "failed")))
        .orderBy(desc(heartbeatRuns.updatedAt), desc(heartbeatRuns.createdAt)),
      db
        .select({
          id: agents.id,
          name: agents.name,
        })
        .from(agents)
        .where(eq(agents.orgId, orgId)),
    ]);
    const lastReadAt = await lastReadAtPromise;
    const agentNames = new Map(agentRows.map((row) => [row.id, row.name]));
    const items = runRows.map((run) => failedRunCard(run, agentNames.get(run.agentId) ?? null));
    const latestFirstItems = [...items].sort(compareLatestActivity);
    const chronologicalItems = [...items].sort(compareChronologicalActivity);
    const latestActivityAt = latestFirstItems[0]?.latestActivityAt ?? null;
    const unreadCount = systemUnreadCountSince(runRows, lastReadAt);
    return {
      summary: systemSummary(
        "failed-runs",
        "Failed runs",
        runRows.length,
        latestActivityAt,
        unreadCount,
        lastReadAt,
        "No failed runs yet",
        latestFirstItems[0]?.preview ?? null,
      ),
      detail: {
        threadKey: "failed-runs",
        kind: "failed-runs",
        title: "Failed runs",
        subtitle: `${runRows.length} recent failure${runRows.length === 1 ? "" : "s"}`,
        preview: latestFirstItems[0]?.preview ?? null,
        latestActivityAt,
        lastReadAt,
        unreadCount,
        needsAttention: unreadCount > 0,
        isPinned: false,
        href: "/messenger/system/failed-runs",
        description: "Recent failed heartbeat runs",
        items: chronologicalItems,
      } satisfies MessengerThreadDetail<MessengerHeartbeatRunThreadItem>,
    };
  }

  async function loadFailedRunSummaryData(orgId: string, userId: string, threadStates?: ThreadStateSource): Promise<SystemSummaryData> {
    const lastReadAt = await lastReadAtForThread(db, orgId, userId, "failed-runs", threadStates);
    const latestActivitySql = sql<Date | null>`max(coalesce(${heartbeatRuns.updatedAt}, ${heartbeatRuns.createdAt}))`;
    const failedRunPredicate = and(eq(heartbeatRuns.orgId, orgId), eq(heartbeatRuns.status, "failed"));

    const [summaryRows, latestRows, unreadRows] = await Promise.all([
      db
        .select({
          itemCount: sql<number>`count(*)::int`,
          latestActivityAt: latestActivitySql,
        })
        .from(heartbeatRuns)
        .where(failedRunPredicate),
      db
        .select({
          error: heartbeatRuns.error,
          stderrExcerpt: heartbeatRuns.stderrExcerpt,
        })
        .from(heartbeatRuns)
        .where(failedRunPredicate)
        .orderBy(desc(heartbeatRuns.updatedAt), desc(heartbeatRuns.createdAt))
        .limit(1),
      lastReadAt
        ? db
          .select({
            unreadCount: sql<number>`count(*)::int`,
          })
          .from(heartbeatRuns)
          .where(and(failedRunPredicate, gt(heartbeatRuns.updatedAt, lastReadAt)))
        : Promise.resolve([]),
    ]);

    const summaryRow = summaryRows[0];
    const latestRun = latestRows[0] ?? null;
    const itemCount = Number(summaryRow?.itemCount ?? 0);
    const unreadCount = lastReadAt ? Number(unreadRows[0]?.unreadCount ?? 0) : itemCount;
    return {
      itemCount,
      summary: systemSummary(
        "failed-runs",
        "Failed runs",
        itemCount,
        normalizeDate(summaryRow?.latestActivityAt ?? null),
        unreadCount,
        lastReadAt,
        "No failed runs yet",
        latestRun ? FAILED_RUN_USER_SUMMARY : null,
      ),
    };
  }

  async function loadBudgetAlertData(orgId: string, userId: string, threadStates?: ThreadStateSource) {
    const lastReadAtPromise = lastReadAtForThread(db, orgId, userId, "budget-alerts", threadStates);
    const incidents = ((await budgetsSvc.overview(orgId)).activeIncidents ?? []) as BudgetIncidentRow[];
    const lastReadAt = await lastReadAtPromise;

    const items = incidents.map((incident) => budgetCard(incident));
    const latestActivityAt = items[0]?.latestActivityAt ?? null;
    const unreadCount = systemUnreadCountSince(incidents, lastReadAt);
    return {
      summary: systemSummary(
        "budget-alerts",
        "Budget alerts",
        incidents.length,
        latestActivityAt,
        unreadCount,
        lastReadAt,
        "No budget alerts yet",
        items[0]?.preview ?? null,
      ),
      detail: {
        threadKey: "budget-alerts",
        kind: "budget-alerts",
        title: "Budget alerts",
        subtitle: `${incidents.length} active alert${incidents.length === 1 ? "" : "s"}`,
        preview: items[0]?.preview ?? null,
        latestActivityAt,
        lastReadAt,
        unreadCount,
        needsAttention: unreadCount > 0,
        isPinned: false,
        href: "/messenger/system/budget-alerts",
        description: "Open budget incidents",
        items,
      } satisfies MessengerThreadDetail<MessengerBudgetThreadItem>,
    };
  }

  async function loadJoinRequestData(orgId: string, userId: string, threadStates?: ThreadStateSource) {
    const lastReadAtPromise = lastReadAtForThread(db, orgId, userId, "join-requests", threadStates);
    const rows = (await db
      .select()
      .from(joinRequests)
      .where(and(eq(joinRequests.orgId, orgId), eq(joinRequests.status, "pending_approval")))
      .orderBy(desc(joinRequests.updatedAt), desc(joinRequests.createdAt))) as JoinRequestRow[];
    const lastReadAt = await lastReadAtPromise;
    const items = rows.map((row) => joinRequestCard(row));
    const latestActivityAt = items[0]?.latestActivityAt ?? null;
    const unreadCount = systemUnreadCountSince(rows, lastReadAt);
    return {
      summary: systemSummary(
        "join-requests",
        "Join requests",
        rows.length,
        latestActivityAt,
        unreadCount,
        lastReadAt,
        "No pending join requests",
        items[0]?.preview ?? null,
      ),
      detail: {
        threadKey: "join-requests",
        kind: "join-requests",
        title: "Join requests",
        subtitle: `${rows.length} pending request${rows.length === 1 ? "" : "s"}`,
        preview: items[0]?.preview ?? null,
        latestActivityAt,
        lastReadAt,
        unreadCount,
        needsAttention: unreadCount > 0,
        isPinned: false,
        href: "/messenger/system/join-requests",
        description: "Pending organization join requests",
        items,
      } satisfies MessengerThreadDetail<MessengerJoinRequestThreadItem>,
    };
  }

  async function loadJoinRequestSummaryData(orgId: string, userId: string, threadStates?: ThreadStateSource): Promise<SystemSummaryData> {
    const lastReadAt = await lastReadAtForThread(db, orgId, userId, "join-requests", threadStates);
    const latestActivitySql = sql<Date | null>`max(coalesce(${joinRequests.updatedAt}, ${joinRequests.createdAt}))`;
    const joinRequestPredicate = and(eq(joinRequests.orgId, orgId), eq(joinRequests.status, "pending_approval"));

    const [summaryRows, latestRows, unreadRows] = await Promise.all([
      db
        .select({
          itemCount: sql<number>`count(*)::int`,
          latestActivityAt: latestActivitySql,
        })
        .from(joinRequests)
        .where(joinRequestPredicate),
      db
        .select({
          capabilities: joinRequests.capabilities,
          requestEmailSnapshot: joinRequests.requestEmailSnapshot,
        })
        .from(joinRequests)
        .where(joinRequestPredicate)
        .orderBy(desc(joinRequests.updatedAt), desc(joinRequests.createdAt))
        .limit(1),
      lastReadAt
        ? db
          .select({
            unreadCount: sql<number>`count(*)::int`,
          })
          .from(joinRequests)
          .where(and(joinRequestPredicate, gt(joinRequests.updatedAt, lastReadAt)))
        : Promise.resolve([]),
    ]);

    const summaryRow = summaryRows[0];
    const latestRequest = latestRows[0] ?? null;
    const itemCount = Number(summaryRow?.itemCount ?? 0);
    const unreadCount = lastReadAt ? Number(unreadRows[0]?.unreadCount ?? 0) : itemCount;
    return {
      itemCount,
      summary: systemSummary(
        "join-requests",
        "Join requests",
        itemCount,
        normalizeDate(summaryRow?.latestActivityAt ?? null),
        unreadCount,
        lastReadAt,
        "No pending join requests",
        latestRequest?.capabilities ?? latestRequest?.requestEmailSnapshot ?? null,
      ),
    };
  }

  async function listThreadSummaries(orgId: string, userId: string) {
    const syntheticThreadStates = loadThreadStates(db, orgId, userId, [
      "issues",
      "approvals",
      "failed-runs",
      "budget-alerts",
      "join-requests",
    ]);
    const [chats, issueData, approvalData, failedRunData, budgetData, joinRequestData] = await Promise.all([
      chatsSvc.listSummaries(orgId, { status: "active" }, userId),
      loadIssueThreadSummaryData(orgId, userId, syntheticThreadStates),
      loadApprovalThreadSummaryData(orgId, userId, syntheticThreadStates),
      loadFailedRunSummaryData(orgId, userId, syntheticThreadStates),
      loadBudgetAlertData(orgId, userId, syntheticThreadStates),
      loadJoinRequestSummaryData(orgId, userId, syntheticThreadStates),
    ]);

    const syntheticSummaries: MessengerThreadSummary[] = [];
    if (issueData.itemCount > 0) syntheticSummaries.push(issueData.summary);
    if (approvalData.itemCount > 0) syntheticSummaries.push(approvalData.summary);
    if (failedRunData.itemCount > 0) syntheticSummaries.push(failedRunData.summary);
    if (budgetData.detail.items.length > 0) syntheticSummaries.push(budgetData.summary);
    if (joinRequestData.itemCount > 0) syntheticSummaries.push(joinRequestData.summary);

    const threadSummaries: MessengerThreadSummary[] = [
      ...chats.map(chatSummary),
      ...syntheticSummaries,
    ].sort((a, b) => {
      const aTime = a.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bTime = b.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (aTime !== bTime) return bTime - aTime;
      return a.title.localeCompare(b.title);
    });

    return threadSummaries;
  }

  async function listThreadSummaryPage(
    orgId: string,
    userId: string,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<MessengerThreadSummaryPage> {
    const limit = normalizeThreadSummaryLimit(options.limit);
    const cursor = decodeThreadSummaryCursor(options.cursor);
    const syntheticThreadStates = loadThreadStates(db, orgId, userId, [
      "issues",
      "approvals",
      "failed-runs",
      "budget-alerts",
      "join-requests",
    ]);
    const [
      issueData,
      approvalData,
      failedRunData,
      budgetData,
      joinRequestData,
    ] = await Promise.all([
      loadIssueThreadSummaryData(orgId, userId, syntheticThreadStates),
      loadApprovalThreadSummaryData(orgId, userId, syntheticThreadStates),
      loadFailedRunSummaryData(orgId, userId, syntheticThreadStates),
      loadBudgetAlertData(orgId, userId, syntheticThreadStates),
      loadJoinRequestSummaryData(orgId, userId, syntheticThreadStates),
    ]);

    const syntheticSummaries: MessengerThreadSummary[] = [];
    if (issueData.itemCount > 0) syntheticSummaries.push(issueData.summary);
    if (approvalData.itemCount > 0) syntheticSummaries.push(approvalData.summary);
    if (failedRunData.itemCount > 0) syntheticSummaries.push(failedRunData.summary);
    if (budgetData.detail.items.length > 0) syntheticSummaries.push(budgetData.summary);
    if (joinRequestData.itemCount > 0) syntheticSummaries.push(joinRequestData.summary);
    const syntheticAfterCursor = syntheticSummaries.filter((summary) => threadSummaryIsAfterCursor(summary, cursor));
    const chatLimit = limit + syntheticAfterCursor.length + 1;
    const chatAfter = cursor
      ? {
        activityAt: new Date(cursor.activityAt),
        title: cursor.title,
        threadKey: cursor.threadKey,
      }
      : null;
    const chats = await chatsSvc.listSummaries(orgId, {
      status: "active",
      limit: chatLimit,
      after: chatAfter,
    }, userId);
    const combined = [
      ...chats.map(chatSummary),
      ...syntheticAfterCursor,
    ]
      .filter((summary) => threadSummaryIsAfterCursor(summary, cursor))
      .sort(compareLatestActivity);
    const items = combined.slice(0, limit);
    const hasMore = combined.length > limit;

    return {
      items,
      pageInfo: threadSummaryPageInfo(limit, items, hasMore),
    };
  }

  async function getIssuesThread(
    orgId: string,
    userId: string,
    options: Pick<IssueThreadDetailOptions, "limit" | "cursor"> = {},
  ) {
    return loadIssueSummaryData(orgId, userId, undefined, options);
  }

  async function getApprovalsThread(orgId: string, userId: string) {
    return loadApprovalSummaryData(orgId, userId);
  }

  async function getSystemThread(orgId: string, userId: string, threadKind: MessengerSystemThreadKind) {
    switch (threadKind) {
      case "failed-runs":
        return loadFailedRunData(orgId, userId);
      case "budget-alerts":
        return loadBudgetAlertData(orgId, userId);
      case "join-requests":
        return loadJoinRequestData(orgId, userId);
      default:
        return null;
    }
  }

  async function getChatThread(conversationId: string, userId: string) {
    const conversation = await chatsSvc.getById(conversationId, userId);
    if (!conversation) return null;
    const messages = await chatsSvc.listMessages(conversationId);
    return {
      conversation: conversation as ChatConversationRow,
      messages: messages as ChatMessageRow[],
    };
  }

  async function getThreadState(orgId: string, userId: string, threadKey: string) {
    return db
      .select()
      .from(messengerThreadUserStates)
      .where(and(eq(messengerThreadUserStates.orgId, orgId), eq(messengerThreadUserStates.userId, userId), eq(messengerThreadUserStates.threadKey, threadKey)))
      .then((rows) => rows[0] ?? null);
  }

  async function markThreadRead(orgId: string, userId: string, threadKey: string, readAt = new Date()) {
    if (threadKey.startsWith("chat:")) {
      const conversationId = threadKey.slice("chat:".length);
      const conversation = await chatsSvc.getById(conversationId, userId);
      if (!conversation || conversation.orgId !== orgId) {
        return null;
      }
      const state = await chatsSvc.markRead(conversationId, orgId, userId, readAt);
      if (!state) return null;
      return { lastReadAt: state.lastReadAt } as ThreadReadState;
    }

    const now = new Date();
    const [row] = await db
      .insert(messengerThreadUserStates)
      .values({
        orgId,
        userId,
        threadKey,
        lastReadAt: readAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          messengerThreadUserStates.orgId,
          messengerThreadUserStates.threadKey,
          messengerThreadUserStates.userId,
        ],
        set: {
          lastReadAt: readAt,
          updatedAt: now,
        },
      })
      .returning();
    return row ? ({ lastReadAt: row.lastReadAt } as ThreadReadState) : null;
  }

  return {
    listThreadSummaries,
    listThreadSummaryPage,
    getChatThread,
    getIssuesThread,
    getApprovalsThread,
    getSystemThread,
    getThreadState,
    markThreadRead,
    setThreadRead: markThreadRead,
  };
}
