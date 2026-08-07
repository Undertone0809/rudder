/**
 * @fileoverview Messenger thread aggregation service for chat, issue,
 * approval, budget, failed-run, join-request, and custom grouped threads.
 *
 * @see doc/product/domains/collaboration/chat-messenger-im.md - Messenger and chat thread behavior
 * @see doc/product/surfaces/surface-domain-map.md - surface-to-domain routing map
 * @see doc/product/domains/governance-and-visibility/dashboard-calendar-inbox.md - operator inbox signals
 */
import type { Db } from "@rudderhq/db";
import {
  activityLog,
  agents,
  approvalComments,
  approvals,
  authUsers,
  chatConversations,
  heartbeatRuns,
  issueComments,
  issueFollows,
  issues,
  joinRequests,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  messengerSavedViews,
  messengerThreadUserStates,
  projects
} from "@rudderhq/db";
import {
  formatMessengerPreview,
  formatMessengerTitle,
  isUuidLike,
  issueUpdatedChangedKeys,
  messengerSavedViewIdSchema,
  type AgentRole,
  type Approval,
  type BudgetIncident,
  type JoinRequest,
  type MessengerApprovalThreadItem,
  type MessengerBudgetThreadItem,
  type MessengerCustomGroupsResponse,
  type MessengerFailedRunThreadItem,
  type MessengerIssueThreadItem,
  type MessengerJoinRequestThreadItem,
  type MessengerRunOriginDescriptor,
  type MessengerSystemThreadKind,
  type MessengerThreadAction,
  type MessengerThreadDetail,
  type MessengerThreadPageInfo,
  type MessengerThreadSummary,
  type MessengerThreadSummaryPage
} from "@rudderhq/shared";
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { chatService } from "./chats.js";
import { issueLowSignalContentOnlyActivitySql } from "./issue-activity-filters.js";
import { listMessengerCustomGroups } from "./messenger-custom-groups.js";
import {
  hydrateMessengerFailedRunOrigins,
  messengerFailedRunSourceAction,
  type MessengerFailedRunOriginRow,
} from "./messenger-run-origin.js";
import { failedRunUserSummary } from "./messenger-run-summary.js";
import {
  deleteEmptyMessengerCustomGroup,
  lockMessengerCustomGroupPlacement,
  lockMessengerOwnerPlacement,
  lockMessengerSavedViewPlacement,
} from "./messenger-saved-views.js";
import {
  comparePinnedThenLatest,
  decodeThreadSummaryCursor,
  encodeThreadSummaryCursor,
  threadSummaryIsAfterCursor,
} from "./messenger-thread-summary-order.js";

const ISSUE_ACTIVITY_ACTIONS = [
  "issue.updated",
  "issue.followed",
  "automation.issue_created_notification",
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
type ThreadSummaryListOptions = {
  splitIssues?: boolean;
};
type ThreadSummaryPageOptions = ThreadSummaryListOptions & {
  limit?: number;
  cursor?: string | null;
};
type IssueThreadCursor = {
  activityAt: string;
  issueId: string;
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
  description: string | null;
  status: string;
  priority: string;
  projectId: string | null;
  projectName: string | null;
  projectColor: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  reviewerUserId: string | null;
  createdByUserId: string | null;
  identifier: string | null;
  executionRunId: string | null;
  hasActiveExecutionRun: boolean;
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
  | "id"
  | "title"
  | "summary"
  | "latestUserMessagePreview"
  | "latestReplyPreview"
  | "lastMessageAt"
  | "updatedAt"
  | "lastReadAt"
  | "unreadCount"
  | "needsAttention"
  | "isPinned"
  | "preferredAgentId"
  | "routedAgentId"
> & {
  activeGenerationId?: string | null;
  chatRuntime?: { runtimeAgentId?: string | null } | null;
  sourceMetadata?: Record<string, unknown> | null;
};
type ChatMessageRow = Awaited<ReturnType<ReturnType<typeof chatService>["listMessages"]>>[number];
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;

type ApprovalCommentRow = {
  approvalId: string;
  body: string;
  createdAt: Date;
};

type FailedRunRow = MessengerFailedRunOriginRow & {
  orgId: string;
  agentId: string;
  status: string;
  resultJson: Record<string, unknown> | null;
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

function messengerIssueHref(issue: IssueUniverseRow) {
  return `/messenger/issues/${issue.identifier ?? issue.id}`;
}

function messengerIssueCommentHref(issue: IssueUniverseRow, commentId: string | null | undefined) {
  const href = messengerIssueHref(issue);
  return commentId ? `${href}#comment-${commentId}` : href;
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

const ISSUE_UPDATE_FIELD_LABELS: Record<string, string> = {
  assigneeAgentId: "assignee",
  assigneeUserId: "assignee",
  assigneeAgentRuntimeOverrides: "assignee runtime overrides",
  billingCode: "billing code",
  executionWorkspaceId: "run workspace",
  executionWorkspacePreference: "run workspace preference",
  executionWorkspaceSettings: "run workspace settings",
  goalId: "goal",
  hiddenAt: "visibility",
  labelIds: "labels",
  parentId: "parent issue",
  projectId: "project",
  projectWorkspaceId: "project workspace",
  requestDepth: "request depth",
  reviewerAgentId: "reviewer",
  reviewerUserId: "reviewer",
};

function humanizeIssueUpdateField(key: string): string {
  return ISSUE_UPDATE_FIELD_LABELS[key] ?? key.replace(/Id$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
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
      const changedField = issueUpdatedChangedKeys(details)[0];
      return changedField ? `${humanizeIssueUpdateField(changedField)} changed` : "Issue details changed";
    }
    case "issue.followed":
      return "Followed";
    case "automation.issue_created_notification":
      return "Automation created issue";
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

function approvalRequesterAgentId(approval: Pick<ApprovalRow, "requestedByAgentId" | "type" | "payload">) {
  if (approval.requestedByAgentId) return approval.requestedByAgentId;
  if (approval.type !== "chat_issue_creation" && approval.type !== "chat_operation") return null;
  const proposedByAgentId = approval.payload?.proposedByAgentId;
  return typeof proposedByAgentId === "string" && isUuidLike(proposedByAgentId)
    ? proposedByAgentId.trim()
    : null;
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
    metadata: {
      preferredAgentId: conversation.preferredAgentId,
      routedAgentId: conversation.routedAgentId,
      runtimeAgentId: conversation.chatRuntime?.runtimeAgentId ?? null,
      latestUserMessagePreview: conversation.latestUserMessagePreview,
      activeGenerationId: conversation.activeGenerationId ?? null,
      ...(conversation.sourceMetadata ?? {}),
    },
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

function splitIssueSummary(
  entry: IssueThreadEntry,
  item: MessengerIssueThreadItem,
  lastReadAt: Date | null,
  threadState: ThreadStateRow | null,
): MessengerThreadSummary {
  const effectiveLastReadAt = maxDate(lastReadAt, threadState?.lastReadAt ?? null);
  const unreadCount = entry.attentionActivityAt && (!effectiveLastReadAt || entry.attentionActivityAt.getTime() > effectiveLastReadAt.getTime())
    ? 1
    : 0;
  return {
    threadKey: `issue:${entry.issue.id}`,
    kind: "issues",
    title: item.title,
    subtitle: item.subtitle,
    preview: item.preview ?? item.body,
    latestActivityAt: item.latestActivityAt,
    lastReadAt: effectiveLastReadAt,
    unreadCount,
    needsAttention: unreadCount > 0,
    isPinned: Boolean(threadState?.pinnedAt),
    href: messengerIssueCommentHref(entry.issue, item.sourceCommentId),
    metadata: {
      ...item.metadata,
      splitIssue: true,
      issueId: entry.issue.id,
      issueIdentifier: entry.issue.identifier,
      description: entry.issue.description,
    },
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
      ...(issue.hasActiveExecutionRun && issue.executionRunId
        ? { activeExecutionRunId: issue.executionRunId }
        : {}),
      ...(issue.assigneeAgentId ? { assigneeAgentId: issue.assigneeAgentId } : {}),
      ...(issue.projectId
        ? {
          projectId: issue.projectId,
          projectName: issue.projectName ?? issue.projectId,
          projectColor: issue.projectColor,
        }
        : {}),
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
  requesterAgent: MessengerApprovalThreadItem["requesterAgent"],
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
    requesterAgent,
  };
}

function failedRunCard(
  run: FailedRunRow,
  agentName: string | null,
  origin: MessengerRunOriginDescriptor,
): MessengerFailedRunThreadItem {
  const summary = failedRunUserSummary(run);
  const sourceAction = messengerFailedRunSourceAction(origin);
  return {
    id: run.id,
    threadKey: "failed-runs",
    kind: "failed-runs",
    title: agentName ? `${agentName} · Failed run` : "Failed run",
    subtitle: run.status.replaceAll("_", " "),
    body: summary,
    preview: summary,
    href: `/agents/${run.agentId}/runs/${run.id}`,
    latestActivityAt: run.updatedAt ?? run.createdAt,
    actions: [
      buildAction("Retry", `/agent-runs/${run.id}/retry`, "POST"),
      ...(sourceAction ? [sourceAction] : []),
      buildAction("Open run", `/agents/${run.agentId}/runs/${run.id}`, "GET"),
    ],
    metadata: {
      runId: run.id,
      agentId: run.agentId,
      status: run.status,
    },
    origin,
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

  function chatConversationIdFromThreadKey(threadKey: string) {
    return threadKey.startsWith("chat:") ? threadKey.slice("chat:".length) : null;
  }

  function issueIdFromThreadKey(threadKey: string) {
    return threadKey.startsWith("issue:") ? threadKey.slice("issue:".length) : null;
  }

  function isSyntheticMessengerThreadKey(threadKey: string) {
    return threadKey === "issues"
      || threadKey === "approvals"
      || threadKey === "failed-runs"
      || threadKey === "budget-alerts"
      || threadKey === "join-requests";
  }

  function savedViewIdFromItemKey(itemKey: string) {
    if (!itemKey.startsWith("saved-view:")) return null;
    const parsed = messengerSavedViewIdSchema.safeParse(itemKey.slice("saved-view:".length));
    if (!parsed.success) throw badRequest("Invalid Messenger Saved View item key");
    return parsed.data;
  }

  async function logSavedViewPlacement(
    database: Db,
    orgId: string,
    userId: string,
    itemKey: string,
    action: string,
    details: Record<string, unknown>,
  ) {
    const savedViewId = savedViewIdFromItemKey(itemKey);
    if (!savedViewId) return;
    await logActivity(database, {
      orgId,
      actorType: "user",
      actorId: userId,
      action,
      entityType: "messenger_saved_view",
      entityId: savedViewId,
      details: { itemKey, ...details },
    });
  }

  async function getCustomGroupOrThrowWithDb(database: Db, orgId: string, userId: string, groupId: string) {
    const [group] = await database
      .select()
      .from(messengerCustomGroups)
      .where(and(
        eq(messengerCustomGroups.orgId, orgId),
        eq(messengerCustomGroups.userId, userId),
        eq(messengerCustomGroups.id, groupId),
      ))
      .limit(1);
    if (!group) throw notFound("Messenger custom group not found");
    return group;
  }

  async function getCustomGroupOrThrow(orgId: string, userId: string, groupId: string) {
    return getCustomGroupOrThrowWithDb(db, orgId, userId, groupId);
  }

  async function loadIssueThreadSummaryById(orgId: string, userId: string, issueId: string): Promise<MessengerThreadSummary | null> {
    const lastReadAtPromise = lastReadAtForThread(db, orgId, userId, "issues");
    const rows = (await db.execute(issueEntryRowsQuery(
      orgId,
      userId,
      sql`
        where id = ${issueId}
        limit 1
      `,
    ))) as IssueThreadEntryRow[];
    const entry = rows[0] ? issueThreadEntryFromRow(rows[0], userId) : null;
    if (!entry) return null;

    const [card] = await buildIssueCardsForEntries(orgId, userId, [entry], "latest");
    if (!card) return null;

    const lastReadAt = await lastReadAtPromise;
    const issueThreadStates = await loadThreadStates(db, orgId, userId, [`issue:${issueId}`]);
    return splitIssueSummary(card.entry, card.item, lastReadAt, issueThreadStates.get(`issue:${issueId}`) ?? null);
  }

  async function loadSyntheticThreadSummaryByKey(orgId: string, userId: string, threadKey: string): Promise<MessengerThreadSummary | null> {
    const syntheticThreadStates = loadThreadStates(db, orgId, userId, [
      "issues",
      "approvals",
      "failed-runs",
      "budget-alerts",
      "join-requests",
    ]);
    switch (threadKey) {
      case "issues": {
        const data = await loadIssueThreadSummaryData(orgId, userId, syntheticThreadStates);
        return data.itemCount > 0 ? data.summary : null;
      }
      case "approvals": {
        const data = await loadApprovalThreadSummaryData(orgId, userId, syntheticThreadStates);
        return data.itemCount > 0 ? data.summary : null;
      }
      case "failed-runs": {
        const data = await loadFailedRunSummaryData(orgId, userId, syntheticThreadStates);
        return data.itemCount > 0 ? data.summary : null;
      }
      case "budget-alerts": {
        const data = await loadBudgetAlertData(orgId, userId, syntheticThreadStates);
        return data.detail.items.length > 0 ? data.summary : null;
      }
      case "join-requests": {
        const data = await loadJoinRequestSummaryData(orgId, userId, syntheticThreadStates);
        return data.itemCount > 0 ? data.summary : null;
      }
      default:
        return null;
    }
  }

  async function findMessengerThreadSummary(orgId: string, userId: string, threadKey: string): Promise<MessengerThreadSummary | null> {
    const conversationId = chatConversationIdFromThreadKey(threadKey);
    if (conversationId) {
      const conversations = await chatsSvc.listSummariesByIds(orgId, [conversationId], userId);
      const conversation = conversations[0];
      return conversation?.messengerVisible !== false ? chatSummary(conversation) : null;
    }

    const issueId = issueIdFromThreadKey(threadKey);
    if (issueId) {
      return loadIssueThreadSummaryById(orgId, userId, issueId);
    }

    return loadSyntheticThreadSummaryByKey(orgId, userId, threadKey);
  }

  async function ensureMessengerThreadCanBeGrouped(orgId: string, userId: string, threadKey: string) {
    const summary = await findMessengerThreadSummary(orgId, userId, threadKey);
    if (!summary) {
      throw notFound("Messenger thread not found");
    }
  }

  async function ensureMessengerThreadCanBeGroupedWithDb(
    database: Db,
    orgId: string,
    _userId: string,
    threadKey: string,
  ) {
    const conversationId = chatConversationIdFromThreadKey(threadKey);
    if (conversationId) {
      const [conversation] = await database
        .select({ id: chatConversations.id })
        .from(chatConversations)
        .where(and(
          eq(chatConversations.orgId, orgId),
          eq(chatConversations.id, conversationId),
          eq(chatConversations.status, "active"),
          eq(chatConversations.messengerVisible, true),
        ))
        .limit(1);
      if (!conversation) throw notFound("Messenger thread not found");
      return;
    }

    const issueId = issueIdFromThreadKey(threadKey);
    if (issueId) {
      const [issue] = await database
        .select({ id: issues.id })
        .from(issues)
        .where(and(
          eq(issues.orgId, orgId),
          eq(issues.id, issueId),
          isNull(issues.hiddenAt),
        ))
        .limit(1);
      if (!issue) throw notFound("Messenger thread not found");
    }
  }

  async function findMessengerSavedViewWithDb(database: Db, orgId: string, userId: string, itemKey: string) {
    const savedViewId = savedViewIdFromItemKey(itemKey);
    if (!savedViewId) return null;
    return database
      .select()
      .from(messengerSavedViews)
      .where(and(
        eq(messengerSavedViews.orgId, orgId),
        eq(messengerSavedViews.userId, userId),
        eq(messengerSavedViews.id, savedViewId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findMessengerSavedView(orgId: string, userId: string, itemKey: string) {
    return findMessengerSavedViewWithDb(db, orgId, userId, itemKey);
  }

  async function listThreadTitles(orgId: string, userId: string, threadKeys: string[]) {
    const titles: string[] = [];
    for (const threadKey of [...new Set(threadKeys)]) {
      const savedView = await findMessengerSavedView(orgId, userId, threadKey);
      if (savedView?.title) {
        titles.push(savedView.title);
        continue;
      }
      const summary = await findMessengerThreadSummary(orgId, userId, threadKey);
      if (summary?.title) titles.push(summary.title);
    }
    return titles;
  }

  async function listCustomGroupThreadTitles(orgId: string, userId: string, groupId: string) {
    await getCustomGroupOrThrow(orgId, userId, groupId);
    const entries = await db
      .select({ threadKey: messengerCustomGroupEntries.threadKey })
      .from(messengerCustomGroupEntries)
      .where(and(
        eq(messengerCustomGroupEntries.orgId, orgId),
        eq(messengerCustomGroupEntries.userId, userId),
        eq(messengerCustomGroupEntries.groupId, groupId),
      ))
      .orderBy(asc(messengerCustomGroupEntries.sortOrder), asc(messengerCustomGroupEntries.createdAt));
    return listThreadTitles(orgId, userId, entries.map((entry) => entry.threadKey));
  }

  async function listCustomGroups(orgId: string, userId: string): Promise<MessengerCustomGroupsResponse> {
    return listMessengerCustomGroups(db, orgId, userId, {
      listChatSummariesByIds: (organizationId, conversationIds, boardUserId) => chatsSvc.listSummariesByIds(organizationId, conversationIds, boardUserId),
      toChatSummary: (conversation) => chatSummary(conversation as ChatSummarySource),
      loadIssueThreadSummaryById,
      loadSyntheticThreadSummaryByKey,
      chatConversationIdFromThreadKey,
      issueIdFromThreadKey,
      isSyntheticMessengerThreadKey,
      savedViewIdFromItemKey,
    });
  }

  async function createCustomGroupWithClient(client: Pick<Db, "insert" | "select">, orgId: string, userId: string, name: string, icon: string | null = null) {
    const [lastGroup] = await client
      .select({ sortOrder: messengerCustomGroups.sortOrder })
      .from(messengerCustomGroups)
      .where(and(eq(messengerCustomGroups.orgId, orgId), eq(messengerCustomGroups.userId, userId)))
      .orderBy(desc(messengerCustomGroups.sortOrder))
      .limit(1);
    const now = new Date();
    const [group] = await client
      .insert(messengerCustomGroups)
      .values({
        orgId,
        userId,
        name,
        icon,
        sortOrder: (lastGroup?.sortOrder ?? -1) + 1,
        pinnedAt: now,
        updatedAt: now,
      })
      .returning();
    return group;
  }

  async function createCustomGroup(orgId: string, userId: string, name: string, icon: string | null = null) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerOwnerPlacement(txDb, orgId, userId);
      return createCustomGroupWithClient(txDb, orgId, userId, name, icon);
    });
  }

  async function updateCustomGroup(
    orgId: string,
    userId: string,
    groupId: string,
    patch: { name?: string; icon?: string | null; collapsed?: boolean; pinned?: boolean; sortOrder?: number },
  ) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerOwnerPlacement(txDb, orgId, userId);
      await lockMessengerCustomGroupPlacement(txDb, orgId, userId, groupId);
      await getCustomGroupOrThrowWithDb(txDb, orgId, userId, groupId);
      const { pinned, ...groupPatch } = patch;
      const updatePatch = {
        ...groupPatch,
        ...(typeof pinned === "boolean" ? { pinnedAt: pinned ? new Date() : null } : {}),
      };
      const [group] = await txDb
        .update(messengerCustomGroups)
        .set({
          ...updatePatch,
          updatedAt: new Date(),
        })
        .where(and(
          eq(messengerCustomGroups.orgId, orgId),
          eq(messengerCustomGroups.userId, userId),
          eq(messengerCustomGroups.id, groupId),
        ))
        .returning();
      return group;
    });
  }

  async function removeCustomGroup(
    orgId: string,
    userId: string,
    groupId: string,
    source: "group_delete" | "group_separate",
  ) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerSavedViewPlacement(txDb, orgId, userId);
      await lockMessengerCustomGroupPlacement(txDb, orgId, userId, groupId);
      await getCustomGroupOrThrowWithDb(txDb, orgId, userId, groupId);
      const savedMemberships = (await txDb
        .select({ threadKey: messengerCustomGroupEntries.threadKey })
        .from(messengerCustomGroupEntries)
        .where(and(
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          eq(messengerCustomGroupEntries.groupId, groupId),
        )))
        .filter((entry) => entry.threadKey.startsWith("saved-view:"));
      for (const membership of savedMemberships) {
        await logSavedViewPlacement(
          txDb,
          orgId,
          userId,
          membership.threadKey,
          "messenger.saved_view_group_removed",
          { groupId, source },
        );
      }
      const [group] = await txDb
        .delete(messengerCustomGroups)
        .where(and(
          eq(messengerCustomGroups.orgId, orgId),
          eq(messengerCustomGroups.userId, userId),
          eq(messengerCustomGroups.id, groupId),
        ))
        .returning();
      return group;
    });
  }

  async function separateCustomGroup(orgId: string, userId: string, groupId: string) {
    return removeCustomGroup(orgId, userId, groupId, "group_separate");
  }

  async function deleteCustomGroup(orgId: string, userId: string, groupId: string) {
    return removeCustomGroup(orgId, userId, groupId, "group_delete");
  }

  async function reorderCustomGroups(orgId: string, userId: string, groupIds: string[]) {
    const uniqueGroupIds = [...new Set(groupIds)];
    if (uniqueGroupIds.length === 0) return listCustomGroups(orgId, userId);
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerOwnerPlacement(txDb, orgId, userId);
      const ownedGroups = await txDb
        .select({ id: messengerCustomGroups.id })
        .from(messengerCustomGroups)
        .where(and(
          eq(messengerCustomGroups.orgId, orgId),
          eq(messengerCustomGroups.userId, userId),
          inArray(messengerCustomGroups.id, uniqueGroupIds),
        ));
      if (ownedGroups.length !== uniqueGroupIds.length) {
        throw notFound("Messenger custom group not found");
      }
      for (const groupId of [...uniqueGroupIds].sort()) {
        await lockMessengerCustomGroupPlacement(txDb, orgId, userId, groupId);
      }
      const now = new Date();
      for (const [index, groupId] of uniqueGroupIds.entries()) {
        await txDb
          .update(messengerCustomGroups)
          .set({ sortOrder: index, updatedAt: now })
          .where(and(
            eq(messengerCustomGroups.orgId, orgId),
            eq(messengerCustomGroups.userId, userId),
            eq(messengerCustomGroups.id, groupId),
          ));
      }
    });
    return listCustomGroups(orgId, userId);
  }

  async function assignThreadToCustomGroupWithClient(database: Db, orgId: string, userId: string, groupId: string, threadKey: string) {
    const [lastEntry] = await database
      .select({ sortOrder: messengerCustomGroupEntries.sortOrder })
      .from(messengerCustomGroupEntries)
      .where(and(
        eq(messengerCustomGroupEntries.orgId, orgId),
        eq(messengerCustomGroupEntries.userId, userId),
        eq(messengerCustomGroupEntries.groupId, groupId),
      ))
      .orderBy(desc(messengerCustomGroupEntries.sortOrder))
      .limit(1);
    const now = new Date();
    const [entry] = await database
      .insert(messengerCustomGroupEntries)
      .values({
        orgId,
        userId,
        groupId,
        threadKey,
        sortOrder: (lastEntry?.sortOrder ?? -1) + 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          messengerCustomGroupEntries.orgId,
          messengerCustomGroupEntries.userId,
          messengerCustomGroupEntries.threadKey,
        ],
        set: {
          groupId,
          sortOrder: (lastEntry?.sortOrder ?? -1) + 1,
          updatedAt: now,
        },
      })
      .returning();
    if (savedViewIdFromItemKey(threadKey)) {
      const { threadKey: _storedItemKey, ...entryFields } = entry;
      return { ...entryFields, itemKey: threadKey };
    }
    return { ...entry, itemKey: threadKey };
  }

  async function assignThreadToCustomGroup(orgId: string, userId: string, groupId: string, threadKey: string) {
    const savedViewId = savedViewIdFromItemKey(threadKey);
    if (!savedViewId) {
      await ensureMessengerThreadCanBeGrouped(orgId, userId, threadKey);
    }
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // The owner lock keeps the source membership stable while we resolve and
      // acquire all affected group locks. Saved placements also share it with
      // Saved View delete, preventing a post-cleanup orphan insert.
      await lockMessengerSavedViewPlacement(txDb, orgId, userId);
      const [existingMembership] = await txDb
        .select({ groupId: messengerCustomGroupEntries.groupId })
        .from(messengerCustomGroupEntries)
        .where(and(
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          eq(messengerCustomGroupEntries.threadKey, threadKey),
        ))
        .limit(1);
      const affectedGroupIds = [...new Set([existingMembership?.groupId, groupId].filter((id): id is string => Boolean(id)))].sort();
      for (const affectedGroupId of affectedGroupIds) {
        await lockMessengerCustomGroupPlacement(txDb, orgId, userId, affectedGroupId);
      }
      if (!savedViewId) {
        await ensureMessengerThreadCanBeGroupedWithDb(txDb, orgId, userId, threadKey);
      }
      await getCustomGroupOrThrowWithDb(txDb, orgId, userId, groupId);
      if (savedViewId && !await findMessengerSavedViewWithDb(txDb, orgId, userId, threadKey)) {
        throw notFound("Messenger Saved View not found");
      }
      const entry = await assignThreadToCustomGroupWithClient(txDb, orgId, userId, groupId, threadKey);
      if (existingMembership && existingMembership.groupId !== groupId) {
        await deleteEmptyMessengerCustomGroup(txDb, orgId, userId, existingMembership.groupId);
      }
      if (savedViewId) {
        await logSavedViewPlacement(txDb, orgId, userId, threadKey, "messenger.saved_view_group_assigned", { groupId });
      }
      return entry;
    });
  }

  async function createCustomGroupWithEntries(
    orgId: string,
    userId: string,
    name: string,
    icon: string | null,
    threadKeys: string[],
    anchorItemKey?: string,
  ) {
    const uniqueThreadKeys = [...new Set(threadKeys)];
    if (uniqueThreadKeys.length === 0) throw badRequest("At least one thread key is required");
    if (anchorItemKey && !uniqueThreadKeys.includes(anchorItemKey)) {
      throw badRequest("Messenger group anchor must be included in the item keys");
    }
    if (
      anchorItemKey
      && anchorItemKey !== "issues"
      && !anchorItemKey.startsWith("chat:")
      && !anchorItemKey.startsWith("issue:")
    ) {
      throw badRequest("Messenger group anchor must be a Chat or Issue");
    }
    const savedViewItemKeys = new Set<string>();
    for (const threadKey of uniqueThreadKeys) {
      if (savedViewIdFromItemKey(threadKey)) savedViewItemKeys.add(threadKey);
      else await ensureMessengerThreadCanBeGrouped(orgId, userId, threadKey);
    }
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerSavedViewPlacement(txDb, orgId, userId);
      const existingMemberships = await txDb
        .select({ threadKey: messengerCustomGroupEntries.threadKey, groupId: messengerCustomGroupEntries.groupId })
        .from(messengerCustomGroupEntries)
        .where(and(
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          inArray(messengerCustomGroupEntries.threadKey, uniqueThreadKeys),
        ));
      const anchorMembership = anchorItemKey
        ? existingMemberships.find((membership) => membership.threadKey === anchorItemKey) ?? null
        : null;
      const group = anchorMembership
        ? await getCustomGroupOrThrowWithDb(
          txDb,
          orgId,
          userId,
          anchorMembership.groupId,
        )
        : await createCustomGroupWithClient(tx, orgId, userId, name, icon);
      const existingGroupIds = [...new Set(existingMemberships.map((membership) => membership.groupId))];
      const affectedGroupIds = [...new Set([...existingGroupIds, group.id])].sort();
      for (const affectedGroupId of affectedGroupIds) {
        await lockMessengerCustomGroupPlacement(txDb, orgId, userId, affectedGroupId);
      }
      for (const threadKey of uniqueThreadKeys) {
        if (savedViewItemKeys.has(threadKey) && !await findMessengerSavedViewWithDb(txDb, orgId, userId, threadKey)) {
          throw notFound("Messenger Saved View not found");
        }
        await assignThreadToCustomGroupWithClient(txDb, orgId, userId, group.id, threadKey);
        await logSavedViewPlacement(txDb, orgId, userId, threadKey, "messenger.saved_view_group_assigned", {
          groupId: group.id,
          source: anchorMembership ? "group_reuse" : "group_create",
        });
      }
      for (const existingGroupId of existingGroupIds) {
        if (existingGroupId !== group.id) {
          await deleteEmptyMessengerCustomGroup(txDb, orgId, userId, existingGroupId);
        }
      }
    });
    return listCustomGroups(orgId, userId);
  }

  async function removeThreadFromCustomGroups(orgId: string, userId: string, threadKey: string) {
    const savedViewId = savedViewIdFromItemKey(threadKey);
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerSavedViewPlacement(txDb, orgId, userId);
      if (savedViewId) {
        if (!await findMessengerSavedViewWithDb(txDb, orgId, userId, threadKey)) {
          throw notFound("Messenger Saved View not found");
        }
      }
      const [membership] = await txDb
        .select({ id: messengerCustomGroupEntries.id, groupId: messengerCustomGroupEntries.groupId })
        .from(messengerCustomGroupEntries)
        .where(and(
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          eq(messengerCustomGroupEntries.threadKey, threadKey),
        ))
        .limit(1);
      if (!membership) return;
      await lockMessengerCustomGroupPlacement(txDb, orgId, userId, membership.groupId);
      const deleted = await txDb
        .delete(messengerCustomGroupEntries)
        .where(and(
          eq(messengerCustomGroupEntries.id, membership.id),
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          eq(messengerCustomGroupEntries.groupId, membership.groupId),
          eq(messengerCustomGroupEntries.threadKey, threadKey),
        ))
        .returning({ id: messengerCustomGroupEntries.id });
      if (deleted.length > 0) {
        await deleteEmptyMessengerCustomGroup(txDb, orgId, userId, membership.groupId);
      }
      if (savedViewId && deleted.length > 0) {
        await logSavedViewPlacement(txDb, orgId, userId, threadKey, "messenger.saved_view_group_removed", {
          groupId: membership.groupId,
          source: "item_remove",
        });
      }
    });
    return savedViewId ? { itemKey: threadKey } : { itemKey: threadKey, threadKey };
  }

  async function reorderCustomGroupEntries(orgId: string, userId: string, groupId: string, threadKeys: string[]) {
    if (new Set(threadKeys).size !== threadKeys.length) {
      throw badRequest("Messenger custom group reorder keys must be unique");
    }
    for (const itemKey of threadKeys) savedViewIdFromItemKey(itemKey);
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerSavedViewPlacement(txDb, orgId, userId);
      await lockMessengerCustomGroupPlacement(txDb, orgId, userId, groupId);
      await getCustomGroupOrThrowWithDb(txDb, orgId, userId, groupId);
      const entries = await txDb
        .select()
        .from(messengerCustomGroupEntries)
        .where(and(
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          eq(messengerCustomGroupEntries.groupId, groupId),
        ))
        .orderBy(asc(messengerCustomGroupEntries.sortOrder), asc(messengerCustomGroupEntries.createdAt));
      const savedIds = entries
        .map((entry) => savedViewIdFromItemKey(entry.threadKey))
        .filter((id): id is string => Boolean(id));
      const savedViews = savedIds.length > 0
        ? await txDb
          .select({ id: messengerSavedViews.id, hiddenAt: messengerSavedViews.hiddenAt })
          .from(messengerSavedViews)
          .where(and(
            eq(messengerSavedViews.orgId, orgId),
            eq(messengerSavedViews.userId, userId),
            inArray(messengerSavedViews.id, savedIds),
          ))
        : [];
      const hiddenSavedIds = new Set(savedViews.filter((view) => view.hiddenAt).map((view) => view.id));
      const visibleEntries = entries.filter((entry) => {
        const savedViewId = savedViewIdFromItemKey(entry.threadKey);
        return !savedViewId || !hiddenSavedIds.has(savedViewId);
      });
      const visibleByKey = new Map(visibleEntries.map((entry) => [entry.threadKey, entry]));
      const requested = new Set(threadKeys);
      const orderedKeys = [
        ...threadKeys.filter((itemKey) => visibleByKey.has(itemKey)),
        ...visibleEntries.map((entry) => entry.threadKey).filter((itemKey) => !requested.has(itemKey)),
      ];
      const visibleSlots = visibleEntries.map((entry) => entry.sortOrder);
      const now = new Date();
      const changedSavedItemKeys: string[] = [];
      for (const [index, itemKey] of orderedKeys.entries()) {
        const entry = visibleByKey.get(itemKey);
        const nextSortOrder = visibleSlots[index];
        if (!entry || nextSortOrder === undefined || entry.sortOrder === nextSortOrder) continue;
        await txDb
          .update(messengerCustomGroupEntries)
          .set({ sortOrder: nextSortOrder, updatedAt: now })
          .where(and(
            eq(messengerCustomGroupEntries.orgId, orgId),
            eq(messengerCustomGroupEntries.userId, userId),
            eq(messengerCustomGroupEntries.groupId, groupId),
            eq(messengerCustomGroupEntries.threadKey, itemKey),
          ));
        if (savedViewIdFromItemKey(itemKey)) changedSavedItemKeys.push(itemKey);
      }
      for (const itemKey of changedSavedItemKeys) {
        await logSavedViewPlacement(txDb, orgId, userId, itemKey, "messenger.saved_view_group_reordered", {
          groupId,
          itemKeys: orderedKeys,
        });
      }
    });
    return listCustomGroups(orgId, userId);
  }

  function issueEntryRowsQuery(orgId: string, userId: string, tail = sql``) {
    const lowSignalContentOnlyActivity = issueLowSignalContentOnlyActivitySql("activity_row");
    const externalLowSignalContentOnlyActivity = issueLowSignalContentOnlyActivitySql("external_activity_row");
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
        union
        select notification_issue.id as id
        from ${activityLog} automation_notification_activity
        inner join ${issues} notification_issue
          on automation_notification_activity.entity_id = notification_issue.id::text
          and notification_issue.org_id = automation_notification_activity.org_id
        where automation_notification_activity.org_id = ${orgId}
          and automation_notification_activity.entity_type = 'issue'
          and automation_notification_activity.action = 'automation.issue_created_notification'
          and automation_notification_activity.details->>'userId' = ${userId}
          and notification_issue.hidden_at is null
      ),
      issue_entries as (
        select
          issue_row.id as id,
          issue_row.title as title,
          issue_row.description as description,
          issue_row.status as status,
          issue_row.priority as priority,
          issue_row.project_id as "projectId",
          project_row.name as "projectName",
          project_row.color as "projectColor",
          issue_row.assignee_agent_id as "assigneeAgentId",
          issue_row.assignee_user_id as "assigneeUserId",
          issue_row.reviewer_user_id as "reviewerUserId",
          issue_row.created_by_user_id as "createdByUserId",
          issue_row.identifier as identifier,
          issue_row.execution_run_id as "executionRunId",
          exists (
            select 1
            from ${heartbeatRuns} active_execution_run
            where active_execution_run.id = issue_row.execution_run_id
              and active_execution_run.org_id = issue_row.org_id
              and active_execution_run.status in ('queued', 'running')
          ) as "hasActiveExecutionRun",
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
            issue_row.created_at,
            coalesce(latest_external_comment.created_at, issue_row.created_at),
            coalesce(latest_activity.created_at, issue_row.created_at)
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
                latest_own_comment.created_at is null
                or latest_own_comment.created_at < issue_row.updated_at - interval '5 seconds'
              )
              and (
                issue_row.assignee_user_id = ${userId}
                or (issue_row.reviewer_user_id = ${userId} and issue_row.status = 'in_review')
                or exists (
                  select 1
                  from ${issueFollows} attention_follow_row
                  where attention_follow_row.org_id = ${orgId}
                    and attention_follow_row.user_id = ${userId}
                    and attention_follow_row.issue_id = issue_row.id
                )
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
        inner join ${issues} issue_row
          on issue_row.id = tracked_issue_ids.id
          and (
            issue_row.origin_kind <> 'automation_execution'
            or exists (
              select 1
              from ${issueFollows} automation_follow_row
              where automation_follow_row.org_id = ${orgId}
                and automation_follow_row.user_id = ${userId}
                and automation_follow_row.issue_id = issue_row.id
            )
            or exists (
              select 1
              from ${activityLog} automation_notification_visibility
              where automation_notification_visibility.org_id = ${orgId}
                and automation_notification_visibility.entity_type = 'issue'
                and automation_notification_visibility.entity_id = issue_row.id::text
                and automation_notification_visibility.action = 'automation.issue_created_notification'
                and automation_notification_visibility.details->>'userId' = ${userId}
            )
          )
        left join lateral (
          select
            comment_row.body,
            comment_row.created_at
          from ${issueComments} comment_row
          where comment_row.org_id = ${orgId}
            and comment_row.issue_id = issue_row.id
            and comment_row.deleted_at is null
            and (comment_row.author_user_id is null or comment_row.author_user_id <> ${userId})
          order by comment_row.created_at desc, comment_row.id desc
          limit 1
        ) latest_external_comment on true
        left join lateral (
          select
            comment_row.created_at
          from ${issueComments} comment_row
          where comment_row.org_id = ${orgId}
            and comment_row.issue_id = issue_row.id
            and comment_row.deleted_at is null
            and comment_row.author_user_id = ${userId}
          order by comment_row.created_at desc, comment_row.id desc
          limit 1
        ) latest_own_comment on true
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
            and not ${lowSignalContentOnlyActivity}
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
            and not ${externalLowSignalContentOnlyActivity}
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
            and ${issueLowSignalContentOnlyActivitySql("suppressed_activity_row")}
          order by suppressed_activity_row.created_at desc, suppressed_activity_row.id desc
          limit 1
        ) latest_suppressed_activity on true
        left join ${projects} project_row
          on project_row.id = issue_row.project_id
          and project_row.org_id = issue_row.org_id
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
        isNull(issueComments.deletedAt),
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
      description: row.description,
      status: row.status,
      priority: row.priority,
      projectId: row.projectId,
      projectName: row.projectName,
      projectColor: row.projectColor,
      assigneeAgentId: row.assigneeAgentId,
      assigneeUserId: row.assigneeUserId,
      reviewerUserId: row.reviewerUserId,
      createdByUserId: row.createdByUserId,
      identifier: row.identifier,
      executionRunId: row.executionRunId,
      hasActiveExecutionRun: row.hasActiveExecutionRun,
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
            and (issue_thread_state.last_read_at is null or "attentionActivityAt" > issue_thread_state.last_read_at)
        )::int as "unreadCount",
        max("latestActivityAt") as "latestActivityAt"
      from (${issueEntryRowsQuery(orgId, userId)}) issue_entry_stats
      left join ${messengerThreadUserStates} issue_thread_state
        on issue_thread_state.org_id = ${orgId}
        and issue_thread_state.user_id = ${userId}
        and issue_thread_state.thread_key = 'issue:' || issue_entry_stats.id::text
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

  async function loadLatestIssueAttentionAt(orgId: string, userId: string) {
    const rows = (await db.execute(sql<{ latestActivityAt: Date | null }>`
      select max("attentionActivityAt") as "latestActivityAt"
      from (${issueEntryRowsQuery(orgId, userId)}) issue_entry_stats
      where "attentionActivityAt" is not null
    `)) as Array<{ latestActivityAt: Date | null }>;
    return normalizeDate(rows[0]?.latestActivityAt ?? null);
  }

  async function loadLatestIssueAttentionAtById(orgId: string, userId: string, issueId: string) {
    const rows = (await db.execute(sql<{ latestActivityAt: Date | null }>`
      select max("attentionActivityAt") as "latestActivityAt"
      from (${issueEntryRowsQuery(orgId, userId, sql`where id = ${issueId} limit 1`)}) issue_entry_stats
      where "attentionActivityAt" is not null
    `)) as Array<{ latestActivityAt: Date | null }>;
    return normalizeDate(rows[0]?.latestActivityAt ?? null);
  }

  async function loadLatestIssueDisplayEntry(orgId: string, userId: string) {
    const rows = (await db.execute(issueEntryRowsQuery(
      orgId,
      userId,
      sql`
        order by "latestActivityAt" desc, id asc
        limit 1
      `,
    ))) as IssueThreadEntryRow[];
    return rows[0] ? issueThreadEntryFromRow(rows[0], userId) : null;
  }

  function issueSummaryPreviewFromEntry(entry: IssueThreadEntry | null, userId: string) {
    if (!entry) return null;
    if (entry.attentionPreview) return entry.attentionPreview;
    const fallbackPreview = entry.latestActivity
      ? summarizeIssueActivity(entry.latestActivity, entry.issue)
      : issueBodyFromSnapshot(
        entry.issue,
        null,
        entry.issue.followed,
        entry.issue.createdByUserId === userId,
        entry.issue.assigneeUserId === userId,
        entry.issue.reviewerUserId === userId && entry.issue.status === "in_review",
      );
    return issueThreadPreview(entry.issue, fallbackPreview);
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

  async function buildIssueCardsForEntries(
    orgId: string,
    userId: string,
    entries: IssueThreadEntry[],
    order: "latest" | "chronological",
  ) {
    const latestDisplayCommentRows = await loadLatestIssueCommentsForDisplay(orgId, entries.map((entry) => entry.issue.id), userId);
    const latestDisplayCommentByIssue = new Map<string, IssueCommentRow>();
    for (const row of latestDisplayCommentRows) {
      latestDisplayCommentByIssue.set(row.issueId, row);
    }
    const orderedEntries = order === "chronological"
      ? [...entries].sort(compareIssueThreadEntriesChronological)
      : [...entries];
    return orderedEntries.map((entry) => {
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
      return {
        entry,
        item: issueCard(
          entry.issue,
          userId,
          entry.issue.followed,
          latestPreview,
          entry.latestActivityAt,
          sourceComment,
          statusChangeActivity,
        ),
      };
    });
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

    const [stats, latestDisplayEntry, detailEntries] = await Promise.all([
      loadIssueThreadStats(orgId, userId, lastReadAt),
      loadLatestIssueDisplayEntry(orgId, userId),
      options.includeDetail
        ? loadIssueDetailEntries(orgId, userId, detailLimit, decodedCursor)
        : Promise.resolve([] as IssueThreadEntry[]),
    ]);
    const summaryPreview = issueSummaryPreviewFromEntry(latestDisplayEntry, userId);
    const hasMoreDetailEntries = options.includeDetail && detailEntries.length > detailLimit;
    const pageEntries = hasMoreDetailEntries ? detailEntries.slice(0, detailLimit) : detailEntries;
    const cursorEntry = hasMoreDetailEntries ? pageEntries.at(-1) ?? null : null;
    const chronologicalItems = (await buildIssueCardsForEntries(orgId, userId, pageEntries, "chronological"))
      .map(({ item }) => item);

    const data: IssueThreadData = {
      summary: issueSummary(stats.itemCount, stats.latestActivityAt, stats.unreadCount, lastReadAt, summaryPreview),
      itemCount: stats.itemCount,
    };
    if (options.includeDetail) {
      data.detail = {
        threadKey: "issues",
        kind: "issues",
        title: "Issues",
        subtitle: `${stats.itemCount} tracked issue${stats.itemCount === 1 ? "" : "s"}`,
        preview: summaryPreview,
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

  async function loadSplitIssueSummaries(
    orgId: string,
    userId: string,
    threadStates: ThreadStateSource | undefined,
    limit: number,
  ) {
    const lastReadAtPromise = lastReadAtForThread(db, orgId, userId, "issues", threadStates);
    const entries = await loadIssueDetailEntries(orgId, userId, limit, null);
    const pageEntries = entries.slice(0, limit);
    const cards = await buildIssueCardsForEntries(orgId, userId, pageEntries, "latest");
    const lastReadAt = await lastReadAtPromise;
    const issueThreadStates = await loadThreadStates(db, orgId, userId, cards.map(({ entry }) => `issue:${entry.issue.id}`));
    return cards.map(({ entry, item }) => splitIssueSummary(entry, item, lastReadAt, issueThreadStates.get(`issue:${entry.issue.id}`) ?? null));
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
    const requesterAgentIds = typedApprovalRows
      .map((approval) => approvalRequesterAgentId(approval))
      .filter((agentId): agentId is string => Boolean(agentId));
    const requesterAgents = requesterAgentIds.length > 0
      ? await db
          .select({
            id: agents.id,
            name: agents.name,
            icon: agents.icon,
            role: agents.role,
          })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), inArray(agents.id, requesterAgentIds)))
      : [];
    const requesterAgentById = new Map(
      requesterAgents.map((agent) => [
        agent.id,
        {
          ...agent,
          role: agent.role as AgentRole,
        },
      ]),
    );
    const unsortedItems = typedApprovalRows.map((approval) => {
      const latestComment = latestCommentByApproval.get(approval.id) ?? null;
      const latestActivityAt = maxDate(approval.updatedAt, latestComment?.createdAt) ?? approval.updatedAt;
      const requesterAgentId = approvalRequesterAgentId(approval);
      const requesterAgent = requesterAgentId
        ? requesterAgentById.get(requesterAgentId) ?? null
        : null;
      return approvalCard(approval, requesterAgent, latestComment, userId, latestActivityAt);
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
    const pendingApprovalPredicate = and(eq(approvals.orgId, orgId), eq(approvals.status, "pending"));

    const [summaryRows, latestApprovalRows, latestCommentRows, unreadRows] = await Promise.all([
      db
        .select({
          itemCount: sql<number>`count(*)::int`,
        })
        .from(approvals)
        .where(pendingApprovalPredicate),
      db
        .select()
        .from(approvals)
        .where(pendingApprovalPredicate)
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
            and ${approvals.status} = 'pending'
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
        .where(and(eq(approvals.id, latestCommentRow.approvalId), pendingApprovalPredicate))
        .limit(1)
      : [];

    const candidateItems: MessengerApprovalThreadItem[] = [];
    if (latestApproval) {
      const latestComment = (latestApprovalCommentRows[0] ?? null) as ApprovalCommentRow | null;
      const latestActivityAt = maxDate(latestApproval.updatedAt, latestComment?.createdAt) ?? latestApproval.updatedAt;
      candidateItems.push(approvalCard(latestApproval, null, latestComment, userId, latestActivityAt));
    }
    if (latestCommentRow) {
      const approval = (latestCommentApprovalRows[0] ?? null) as ApprovalRow | null;
      if (approval) {
        const latestActivityAt = maxDate(approval.updatedAt, latestCommentRow.createdAt) ?? approval.updatedAt;
        candidateItems.push(approvalCard(approval, null, latestCommentRow, userId, latestActivityAt));
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
          invocationSource: heartbeatRuns.invocationSource,
          triggerDetail: heartbeatRuns.triggerDetail,
          status: heartbeatRuns.status,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
          chatConversationId: heartbeatRuns.chatConversationId,
          resultJson: heartbeatRuns.resultJson,
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
    const origins = await hydrateMessengerFailedRunOrigins(db, orgId, runRows);
    const items = runRows.map((run) => failedRunCard(
      run,
      agentNames.get(run.agentId) ?? null,
      origins.get(run.id)!,
    ));
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
        description: "Recent failed agent runs",
        items: chronologicalItems,
      } satisfies MessengerThreadDetail<MessengerFailedRunThreadItem>,
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
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
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
        latestRun ? failedRunUserSummary(latestRun) : null,
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

  async function listThreadSummaries(
    orgId: string,
    userId: string,
    options: ThreadSummaryListOptions = {},
  ) {
    const syntheticThreadStates = loadThreadStates(db, orgId, userId, [
      "issues",
      "approvals",
      "failed-runs",
      "budget-alerts",
      "join-requests",
    ]);
    const [chats, issueData, splitIssueSummaries, approvalData, failedRunData, budgetData, joinRequestData] = await Promise.all([
      chatsSvc.listSummaries(orgId, { status: "active" }, userId),
      loadIssueThreadSummaryData(orgId, userId, syntheticThreadStates),
      options.splitIssues
        ? loadSplitIssueSummaries(orgId, userId, syntheticThreadStates, MAX_THREAD_SUMMARY_LIMIT)
        : Promise.resolve([] as MessengerThreadSummary[]),
      loadApprovalThreadSummaryData(orgId, userId, syntheticThreadStates),
      loadFailedRunSummaryData(orgId, userId, syntheticThreadStates),
      loadBudgetAlertData(orgId, userId, syntheticThreadStates),
      loadJoinRequestSummaryData(orgId, userId, syntheticThreadStates),
    ]);

    const syntheticSummaries: MessengerThreadSummary[] = [];
    if (options.splitIssues) syntheticSummaries.push(...splitIssueSummaries);
    else if (issueData.itemCount > 0) syntheticSummaries.push(issueData.summary);
    if (approvalData.itemCount > 0) syntheticSummaries.push(approvalData.summary);
    if (failedRunData.itemCount > 0) syntheticSummaries.push(failedRunData.summary);
    if (budgetData.detail.items.length > 0) syntheticSummaries.push(budgetData.summary);
    if (joinRequestData.itemCount > 0) syntheticSummaries.push(joinRequestData.summary);

    const threadSummaries: MessengerThreadSummary[] = [
      ...chats.filter((chat) => chat.messengerVisible !== false).map(chatSummary),
      ...syntheticSummaries,
    ].sort(comparePinnedThenLatest);

    return threadSummaries;
  }

  async function listThreadSummaryPage(
    orgId: string,
    userId: string,
    options: ThreadSummaryPageOptions = {},
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
      splitIssueSummaries,
      approvalData,
      failedRunData,
      budgetData,
      joinRequestData,
    ] = await Promise.all([
      loadIssueThreadSummaryData(orgId, userId, syntheticThreadStates),
      options.splitIssues
        ? loadSplitIssueSummaries(orgId, userId, syntheticThreadStates, MAX_THREAD_SUMMARY_LIMIT)
        : Promise.resolve([] as MessengerThreadSummary[]),
      loadApprovalThreadSummaryData(orgId, userId, syntheticThreadStates),
      loadFailedRunSummaryData(orgId, userId, syntheticThreadStates),
      loadBudgetAlertData(orgId, userId, syntheticThreadStates),
      loadJoinRequestSummaryData(orgId, userId, syntheticThreadStates),
    ]);

    const syntheticSummaries: MessengerThreadSummary[] = [];
    if (options.splitIssues) syntheticSummaries.push(...splitIssueSummaries);
    else if (issueData.itemCount > 0) syntheticSummaries.push(issueData.summary);
    if (approvalData.itemCount > 0) syntheticSummaries.push(approvalData.summary);
    if (failedRunData.itemCount > 0) syntheticSummaries.push(failedRunData.summary);
    if (budgetData.detail.items.length > 0) syntheticSummaries.push(budgetData.summary);
    if (joinRequestData.itemCount > 0) syntheticSummaries.push(joinRequestData.summary);
    const syntheticAfterCursor = syntheticSummaries.filter((summary) => threadSummaryIsAfterCursor(summary, cursor));
    const chatAfter = cursor && !cursor.isPinned
      ? {
        activityAt: new Date(cursor.activityAt),
        title: cursor.title,
        threadKey: cursor.threadKey,
      }
      : null;
    const [pinnedChats, chats] = await Promise.all([
      chatsSvc.listPinnedSummaries(orgId, userId),
      chatsSvc.listSummaries(orgId, {
        status: "active",
        limit: limit + syntheticAfterCursor.length + 1,
        after: chatAfter,
        excludePinned: true,
      }, userId),
    ]);
    const chatSummaries = [
      ...pinnedChats,
      ...chats,
    ].filter((chat) => chat.messengerVisible !== false).reduce<MessengerThreadSummary[]>((summaries, chat) => {
      const summary = chatSummary(chat);
      if (!summaries.some((item) => item.threadKey === summary.threadKey)) {
        summaries.push(summary);
      }
      return summaries;
    }, []);
    const combined = [
      ...chatSummaries,
      ...syntheticAfterCursor,
    ]
      .filter((summary) => threadSummaryIsAfterCursor(summary, cursor))
      .sort(comparePinnedThenLatest);
    const itemLimit = limit;
    const items = combined.slice(0, itemLimit);
    const hasMore = combined.length > itemLimit;

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

  async function countUnreadIssueThreadEntries(orgId: string, userId: string) {
    const lastReadAt = await lastReadAtForThread(db, orgId, userId, "issues");
    const stats = await loadIssueThreadStats(orgId, userId, lastReadAt);
    return stats.unreadCount;
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
    if (!conversation || conversation.messengerVisible === false) return null;
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
      if (!conversation || conversation.orgId !== orgId || conversation.messengerVisible === false) {
        return null;
      }
      const state = await chatsSvc.markRead(conversationId, orgId, userId, readAt);
      if (!state) return null;
      return { lastReadAt: state.lastReadAt } as ThreadReadState;
    }

    const now = new Date();
    let effectiveReadAt = readAt;
    if (threadKey.startsWith("issue:")) {
      const issueId = threadKey.slice("issue:".length);
      if (!await canUseIssueThread(orgId, userId, issueId)) return null;
      effectiveReadAt = maxDate(readAt, await loadLatestIssueAttentionAtById(orgId, userId, issueId)) ?? readAt;
    } else if (threadKey === "issues") {
      effectiveReadAt = maxDate(readAt, await loadLatestIssueAttentionAt(orgId, userId)) ?? readAt;
    }
    const [row] = await db
      .insert(messengerThreadUserStates)
      .values({
        orgId,
        userId,
        threadKey,
        lastReadAt: effectiveReadAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          messengerThreadUserStates.orgId,
          messengerThreadUserStates.threadKey,
          messengerThreadUserStates.userId,
        ],
        set: {
          lastReadAt: effectiveReadAt,
          updatedAt: now,
        },
      })
      .returning();
    return row ? ({ lastReadAt: row.lastReadAt } as ThreadReadState) : null;
  }

  async function dismissUnreadThreads(orgId: string, userId: string) {
    const summaries = await listThreadSummaries(orgId, userId);
    const unreadSummaries = summaries.filter((summary) => summary.unreadCount > 0);
    const dismissedThreadKeys: string[] = [];

    for (const summary of unreadSummaries) {
      const state = await markThreadRead(
        orgId,
        userId,
        summary.threadKey,
        normalizeDate(summary.latestActivityAt) ?? new Date(),
      );
      if (state) dismissedThreadKeys.push(summary.threadKey);
    }

    return {
      dismissedCount: dismissedThreadKeys.length,
      dismissedThreadKeys,
    };
  }

  async function canUseIssueThread(orgId: string, userId: string, issueId: string) {
    const [row] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.orgId, orgId),
        eq(issues.id, issueId),
        or(
          and(
            ne(issues.originKind, "automation_execution"),
            or(
              eq(issues.assigneeUserId, userId),
              eq(issues.reviewerUserId, userId),
              eq(issues.createdByUserId, userId),
            )!,
          ),
          sql`exists (
            select 1
            from ${issueFollows} follow_row
            where follow_row.org_id = ${orgId}
              and follow_row.user_id = ${userId}
              and follow_row.issue_id = ${issues.id}
          )`,
          sql`exists (
            select 1
            from ${activityLog} automation_notification_activity
            where automation_notification_activity.org_id = ${orgId}
              and automation_notification_activity.entity_type = 'issue'
              and automation_notification_activity.entity_id = ${issues.id}::text
              and automation_notification_activity.action = 'automation.issue_created_notification'
              and automation_notification_activity.details->>'userId' = ${userId}
          )`,
        ),
      ))
      .limit(1);
    return Boolean(row);
  }

  async function setThreadPinned(orgId: string, userId: string, threadKey: string, pinned: boolean) {
    if (threadKey.startsWith("chat:")) {
      const conversationId = threadKey.slice("chat:".length);
      const conversation = await chatsSvc.getById(conversationId, userId);
      if (!conversation || conversation.orgId !== orgId) return null;
      await chatsSvc.setPinned(conversationId, orgId, userId, pinned);
      return { threadKey, pinned };
    }

    if (threadKey.startsWith("issue:")) {
      const issueId = threadKey.slice("issue:".length);
      if (!await canUseIssueThread(orgId, userId, issueId)) return null;
    }

    const now = new Date();
    const existing = await getThreadState(orgId, userId, threadKey);
    const [row] = await db
      .insert(messengerThreadUserStates)
      .values({
        orgId,
        userId,
        threadKey,
        lastReadAt: existing?.lastReadAt ?? new Date(0),
        pinnedAt: pinned ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          messengerThreadUserStates.orgId,
          messengerThreadUserStates.threadKey,
          messengerThreadUserStates.userId,
        ],
        set: {
          pinnedAt: pinned ? now : null,
          updatedAt: now,
        },
      })
      .returning();
    return row ? { threadKey, pinned: Boolean(row.pinnedAt) } : null;
  }

  return {
    listCustomGroups,
    listThreadTitles,
    listCustomGroupThreadTitles,
    createCustomGroup,
    createCustomGroupWithEntries,
    updateCustomGroup,
    separateCustomGroup,
    deleteCustomGroup,
    reorderCustomGroups,
    assignThreadToCustomGroup,
    removeThreadFromCustomGroups,
    reorderCustomGroupEntries,
    listThreadSummaries,
    listThreadSummaryPage,
    getChatThread,
    getIssuesThread,
    countUnreadIssueThreadEntries,
    getApprovalsThread,
    getSystemThread,
    getThreadState,
    dismissUnreadThreads,
    markThreadRead,
    setThreadRead: markThreadRead,
    setThreadPinned,
  };
}
