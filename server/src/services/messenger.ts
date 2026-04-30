import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  activityLog,
  approvalComments,
  approvals,
  agents,
  chatConversations,
  heartbeatRuns,
  issueComments,
  issues,
  joinRequests,
  messengerThreadUserStates,
} from "@rudderhq/db";
import {
  formatMessengerPreview,
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
  type MessengerThreadSummary,
} from "@rudderhq/shared";
import { issueService } from "./issues.js";
import { chatService } from "./chats.js";
import { budgetService } from "./budgets.js";
import { redactEventPayload } from "../redaction.js";

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

const ACTIONABLE_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);

type ThreadStateRow = typeof messengerThreadUserStates.$inferSelect;
type ThreadReadState = {
  lastReadAt: Date;
};

type IssueUniverseRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigneeUserId: string | null;
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

function compareLatestActivity<T extends { latestActivityAt: Date | null; title: string }>(a: T, b: T) {
  const aTime = a.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bTime = b.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return bTime - aTime;
  return a.title.localeCompare(b.title);
}

function compareChronologicalActivity<T extends { latestActivityAt: Date | null; title: string }>(a: T, b: T) {
  const aTime = a.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bTime = b.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return a.title.localeCompare(b.title);
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

function issueBodyFromSnapshot(
  issue: IssueUniverseRow,
  latestPreview: string | null,
  followed: boolean,
  created: boolean,
  assigned: boolean,
) {
  const flags: string[] = [];
  if (followed) flags.push("followed");
  if (created) flags.push("created by me");
  if (assigned) flags.push("assigned to me");
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
        return `Status changed to ${details.status.replaceAll("_", " ")}`;
      }
      if (typeof details.assigneeUserId !== "undefined" || typeof details.assigneeAgentId !== "undefined") {
        return "Assignment changed";
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

function isSelfAuthoredComment(comment: IssueCommentRow, userId: string) {
  return comment.authorUserId === userId;
}

function isSelfAuthoredActivity(activity: IssueActivityRow, userId: string) {
  return activity.actorType === "user" && activity.actorId === userId;
}

function summarizeApprovalPayload(approval: ApprovalRow) {
  const payload = redactEventPayload(approval.payload);
  if (!payload) return null;
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
    buildAction("Request revision", `/approvals/${approval.id}/request-revision`, "POST"),
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

function chatSummary(conversation: ChatConversationRow): MessengerThreadSummary {
  const preview =
    conversation.latestReplyPreview ?? conversation.summary ?? truncate(conversation.title, 140) ?? "Start the conversation";
  return {
    threadKey: threadKeyForChat(conversation.id),
    kind: "chat",
    title: conversation.title,
    subtitle: preview,
    preview,
    latestActivityAt: conversation.lastMessageAt ?? conversation.updatedAt,
    lastReadAt: conversation.lastReadAt,
    unreadCount: conversation.unreadCount,
    needsAttention: conversation.needsAttention,
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
    href: `/messenger/system/${kind}`,
  };
}

function issueCard(
  issue: IssueUniverseRow,
  currentUserId: string | null,
  followed: boolean,
  latestPreview: string | null,
  latestActivityAt: Date,
  sourceComment: Pick<IssueCommentRow, "id" | "body"> | null,
): MessengerIssueThreadItem {
  const createdByMe = issue.createdByUserId === currentUserId;
  const assignedToMe = issue.assigneeUserId === currentUserId;
  return {
    id: issue.id,
    threadKey: "issues",
    kind: "issues",
    title: `${issue.identifier ?? issue.id} · ${issue.title}`,
    subtitle: issueBodyFromSnapshot(issue, latestPreview, followed, createdByMe, assignedToMe),
    body: issueBodyFromSnapshot(issue, latestPreview, followed, createdByMe, assignedToMe),
    preview: latestPreview,
    href: issueHref(issue),
    latestActivityAt,
    actions: issueActions(issue, currentUserId),
    metadata: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      status: issue.status,
      priority: issue.priority,
      followed,
      createdByMe,
      assignedToMe,
    },
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    sourceCommentId: sourceComment?.id ?? null,
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
  return {
    id: approval.id,
    threadKey: "approvals",
    kind: "approvals",
    title: approval.type.replaceAll("_", " "),
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
    body: truncate(run.error) ?? truncate(run.stderrExcerpt) ?? "Run exited with an error.",
    preview: truncate(run.error) ?? truncate(run.stderrExcerpt),
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

export function messengerService(db: Db) {
  const issuesSvc = issueService(db);
  const chatsSvc = chatService(db);
  const budgetsSvc = budgetService(db);

  async function loadIssueUniverse(orgId: string, userId: string) {
    const [followRows, trackedRows] = await Promise.all([
      issuesSvc.listFollows(orgId, userId),
      db
        .select({
          id: issues.id,
          orgId: issues.orgId,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeUserId: issues.assigneeUserId,
          createdByUserId: issues.createdByUserId,
          identifier: issues.identifier,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.orgId, orgId),
            or(eq(issues.assigneeUserId, userId), eq(issues.createdByUserId, userId)),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(desc(issues.updatedAt)),
    ]);

    const universe = new Map<string, IssueUniverseRow & { followed: boolean; assigned: boolean }>();
    for (const row of followRows) {
      universe.set(row.issueId, {
        ...row.issue,
        followed: true,
        assigned: row.issue.assigneeUserId === userId,
      });
    }
    for (const row of trackedRows) {
      const existing = universe.get(row.id);
      universe.set(row.id, {
        ...row,
        followed: existing?.followed ?? false,
        assigned: row.assigneeUserId === userId,
      });
    }
    return Array.from(universe.values());
  }

  async function loadIssueSummaryData(orgId: string, userId: string) {
    const issuesUniverse = await loadIssueUniverse(orgId, userId);
    const issueIds = issuesUniverse.map((row) => row.id);
    const threadStates = await loadThreadStates(db, orgId, userId, ["issues"]);
    const lastReadAt = threadStates.get("issues")?.lastReadAt ?? null;

    const [commentRows, activityRows] = await Promise.all([
      issueIds.length === 0
        ? Promise.resolve([] as IssueCommentRow[])
        : db
          .select({
            id: issueComments.id,
            issueId: issueComments.issueId,
            body: issueComments.body,
            authorAgentId: issueComments.authorAgentId,
            authorUserId: issueComments.authorUserId,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(and(eq(issueComments.orgId, orgId), inArray(issueComments.issueId, issueIds)))
          .orderBy(desc(issueComments.createdAt)),
      issueIds.length === 0
        ? Promise.resolve([] as IssueActivityRow[])
        : db
          .select({
            id: activityLog.id,
            action: activityLog.action,
            entityId: activityLog.entityId,
            actorType: activityLog.actorType,
            actorId: activityLog.actorId,
            details: activityLog.details,
            createdAt: activityLog.createdAt,
            runId: activityLog.runId,
          })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.orgId, orgId),
              eq(activityLog.entityType, "issue"),
              inArray(activityLog.entityId, issueIds),
              inArray(activityLog.action, ISSUE_ACTIVITY_ACTIONS as unknown as string[]),
            ),
          )
          .orderBy(desc(activityLog.createdAt)),
    ]);

    const latestCommentByIssue = new Map<string, IssueCommentRow>();
    const latestExternalCommentByIssue = new Map<string, IssueCommentRow>();
    for (const row of commentRows) {
      if (!latestCommentByIssue.has(row.issueId)) {
        latestCommentByIssue.set(row.issueId, row);
      }
      if (!isSelfAuthoredComment(row, userId) && !latestExternalCommentByIssue.has(row.issueId)) {
        latestExternalCommentByIssue.set(row.issueId, row);
      }
    }
    const latestActivityByIssue = new Map<string, IssueActivityRow>();
    const latestExternalActivityByIssue = new Map<string, IssueActivityRow>();
    for (const row of activityRows) {
      if (!latestActivityByIssue.has(row.entityId)) {
        latestActivityByIssue.set(row.entityId, row);
      }
      if (!isSelfAuthoredActivity(row, userId) && !latestExternalActivityByIssue.has(row.entityId)) {
        latestExternalActivityByIssue.set(row.entityId, row);
      }
    }

    const unsortedEntries = issuesUniverse.map((issue) => {
      const latestComment = latestCommentByIssue.get(issue.id) ?? null;
      const latestActivity = latestActivityByIssue.get(issue.id) ?? null;
      const latestCommentAt = normalizeDate(latestComment?.createdAt ?? null);
      const latestEventAt = maxDate(latestCommentAt, latestActivity?.createdAt);
      const latestActivityAt = maxDate(issue.updatedAt, latestEventAt);
      const latestSourceIsComment =
        latestCommentAt &&
        (!latestActivity?.createdAt || latestCommentAt.getTime() >= new Date(latestActivity.createdAt).getTime());
      const latestPreview = latestSourceIsComment
        ? truncate(latestComment?.body)
        : latestActivity
          ? summarizeIssueActivity(latestActivity, issue)
          : null;

      const latestExternalComment = latestExternalCommentByIssue.get(issue.id) ?? null;
      const latestExternalActivity = latestExternalActivityByIssue.get(issue.id) ?? null;
      const latestExternalCommentAt = normalizeDate(latestExternalComment?.createdAt ?? null);
      const fallbackAssignedActivityAt =
        issue.assigneeUserId === userId && !latestActivityByIssue.has(issue.id)
          ? normalizeDate(issue.updatedAt)
          : null;
      const attentionActivityAt = maxDate(
        latestExternalCommentAt,
        latestExternalActivity?.createdAt,
        fallbackAssignedActivityAt,
      );
      const attentionPreview =
        latestExternalCommentAt &&
        (!latestExternalActivity?.createdAt || latestExternalCommentAt.getTime() >= new Date(latestExternalActivity.createdAt).getTime())
          ? truncate(latestExternalComment?.body)
          : latestExternalActivity
            ? summarizeIssueActivity(latestExternalActivity, issue)
            : fallbackAssignedActivityAt
              ? issueBodyFromSnapshot(issue, null, issue.followed, issue.createdByUserId === userId, issue.assigneeUserId === userId)
              : null;

      return {
        item: issueCard(
          issue,
          userId,
          issue.followed,
          latestPreview,
          latestActivityAt ?? issue.updatedAt,
          latestSourceIsComment ? latestComment : null,
        ),
        attentionActivityAt,
        attentionPreview,
      };
    });

    const unsortedItems = unsortedEntries.map((entry) => entry.item);
    const latestFirstEntries = [...unsortedEntries].sort((a, b) => {
      const aTime = a.attentionActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bTime = b.attentionActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (aTime !== bTime) return bTime - aTime;
      return a.item.title.localeCompare(b.item.title);
    });
    const chronologicalItems = [...unsortedItems].sort(compareChronologicalActivity);

    const latestAttentionEntry = latestFirstEntries.find((entry) => entry.attentionActivityAt);
    const latestActivityAt = latestAttentionEntry?.attentionActivityAt ?? null;
    const unreadCount = unsortedEntries.filter((entry) => {
      const itemActivity = entry.attentionActivityAt;
      if (!itemActivity) return false;
      if (!lastReadAt) return true;
      return itemActivity.getTime() > lastReadAt.getTime();
    }).length;

    return {
      summary: issueSummary(issuesUniverse.length, latestActivityAt, unreadCount, lastReadAt, latestAttentionEntry?.attentionPreview ?? null),
      detail: {
        threadKey: "issues",
        kind: "issues",
        title: "Issues",
        subtitle: `${issuesUniverse.length} tracked issue${issuesUniverse.length === 1 ? "" : "s"}`,
        preview: latestAttentionEntry?.attentionPreview ?? null,
        latestActivityAt,
        lastReadAt,
        unreadCount,
        needsAttention: unreadCount > 0,
        href: "/messenger/issues",
        description: "Followed issues, issues I created, and issues assigned to me",
        items: chronologicalItems,
      } satisfies MessengerThreadDetail<MessengerIssueThreadItem>,
    };
  }

  async function loadApprovalSummaryData(orgId: string, userId: string) {
    const threadStates = await loadThreadStates(db, orgId, userId, ["approvals"]);
    const lastReadAt = threadStates.get("approvals")?.lastReadAt ?? null;

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
        href: "/messenger/approvals",
        description: "Approvals needing attention",
        items: chronologicalItems,
      } satisfies MessengerThreadDetail<MessengerApprovalThreadItem>,
    };
  }

  async function loadFailedRunData(orgId: string, userId: string) {
    const threadStates = await loadThreadStates(db, orgId, userId, ["failed-runs"]);
    const lastReadAt = threadStates.get("failed-runs")?.lastReadAt ?? null;

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
        href: "/messenger/system/failed-runs",
        description: "Recent failed heartbeat runs",
        items: chronologicalItems,
      } satisfies MessengerThreadDetail<MessengerHeartbeatRunThreadItem>,
    };
  }

  async function loadBudgetAlertData(orgId: string, userId: string) {
    const threadStates = await loadThreadStates(db, orgId, userId, ["budget-alerts"]);
    const lastReadAt = threadStates.get("budget-alerts")?.lastReadAt ?? null;
    const incidents = ((await budgetsSvc.overview(orgId)).activeIncidents ?? []) as BudgetIncidentRow[];

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
        href: "/messenger/system/budget-alerts",
        description: "Open budget incidents",
        items,
      } satisfies MessengerThreadDetail<MessengerBudgetThreadItem>,
    };
  }

  async function loadJoinRequestData(orgId: string, userId: string) {
    const threadStates = await loadThreadStates(db, orgId, userId, ["join-requests"]);
    const lastReadAt = threadStates.get("join-requests")?.lastReadAt ?? null;
    const rows = (await db
      .select()
      .from(joinRequests)
      .where(and(eq(joinRequests.orgId, orgId), eq(joinRequests.status, "pending_approval")))
      .orderBy(desc(joinRequests.updatedAt), desc(joinRequests.createdAt))) as JoinRequestRow[];
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
        href: "/messenger/system/join-requests",
        description: "Pending organization join requests",
        items,
      } satisfies MessengerThreadDetail<MessengerJoinRequestThreadItem>,
    };
  }

  async function listThreadSummaries(orgId: string, userId: string) {
    const [chats, issueData, approvalData, failedRunData, budgetData, joinRequestData] = await Promise.all([
      chatsSvc.list(orgId, { status: "active" }, userId),
      loadIssueSummaryData(orgId, userId),
      loadApprovalSummaryData(orgId, userId),
      loadFailedRunData(orgId, userId),
      loadBudgetAlertData(orgId, userId),
      loadJoinRequestData(orgId, userId),
    ]);

    const syntheticSummaries: MessengerThreadSummary[] = [];
    if (issueData.detail.items.length > 0) syntheticSummaries.push(issueData.summary);
    if (approvalData.detail.items.length > 0) syntheticSummaries.push(approvalData.summary);
    if (failedRunData.detail.items.length > 0) syntheticSummaries.push(failedRunData.summary);
    if (budgetData.detail.items.length > 0) syntheticSummaries.push(budgetData.summary);
    if (joinRequestData.detail.items.length > 0) syntheticSummaries.push(joinRequestData.summary);

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

  async function getIssuesThread(orgId: string, userId: string) {
    return loadIssueSummaryData(orgId, userId);
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
    getChatThread,
    getIssuesThread,
    getApprovalsThread,
    getSystemThread,
    getThreadState,
    markThreadRead,
    setThreadRead: markThreadRead,
  };
}
