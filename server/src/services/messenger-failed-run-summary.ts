import type { Db } from "@rudderhq/db";
import {
  agentIssueCreationRequests,
  heartbeatRuns,
  messengerThreadUserStates,
} from "@rudderhq/db";
import type { MessengerThreadSummary } from "@rudderhq/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { failedRunUserSummary } from "./messenger-run-summary.js";

type ThreadStateSource = Map<string, { lastReadAt: Date }> | Promise<Map<string, { lastReadAt: Date }>>;

type FailedRunSummaryRow = {
  id: string;
  agentIssueCreationRequestId: string | null;
  userMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type FailedAgentIssueRequestRow = {
  id: string;
  orgId: string;
  agentId: string;
  runId: string | null;
  status: string;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type FailedRunSummaryData = {
  summary: MessengerThreadSummary;
  itemCount: number;
};

function normalizeDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

function failedRunSummary(
  run: Pick<FailedRunSummaryRow, "agentIssueCreationRequestId"> & { resultJson?: Record<string, unknown> | null },
) {
  const summary = failedRunUserSummary(run);
  return run.agentIssueCreationRequestId
    ? `Agent Issue creation failed. ${summary}`
    : summary;
}

function failedAgentIssueRequestSummary(request: Pick<FailedAgentIssueRequestRow, "error">) {
  return `Agent Issue creation failed. ${request.error ?? "Agent run completed without creating an Issue"}`;
}

function systemSummary(
  itemCount: number,
  latestActivityAt: Date | null,
  unreadCount: number,
  lastReadAt: Date | null,
  preview: string | null,
): MessengerThreadSummary {
  return {
    threadKey: "failed-runs",
    kind: "failed-runs",
    title: "Failed runs",
    subtitle: itemCount > 0 ? `${itemCount} item${itemCount === 1 ? "" : "s"}` : "No failed runs yet",
    preview: itemCount > 0 ? preview ?? "Aggregate operational updates" : "No failed runs yet",
    latestActivityAt,
    lastReadAt,
    unreadCount,
    needsAttention: unreadCount > 0,
    isPinned: false,
    href: "/messenger/system/failed-runs",
  };
}

async function loadThreadStates(db: Db, orgId: string, userId: string) {
  const rows = await db
    .select()
    .from(messengerThreadUserStates)
    .where(and(
      eq(messengerThreadUserStates.orgId, orgId),
      eq(messengerThreadUserStates.userId, userId),
      eq(messengerThreadUserStates.threadKey, "failed-runs"),
    ));
  return new Map(rows.map((row) => [row.threadKey, { lastReadAt: row.lastReadAt }]));
}

async function lastReadAtForThread(
  db: Db,
  orgId: string,
  userId: string,
  threadStates?: ThreadStateSource,
) {
  const states = threadStates ?? loadThreadStates(db, orgId, userId);
  return (await states).get("failed-runs")?.lastReadAt ?? null;
}

async function loadFailedRunSummaryRows(db: Db, orgId: string, userId: string) {
  const [runRows, requestRows] = await Promise.all([
    db
      .select({
        id: heartbeatRuns.id,
        agentIssueCreationRequestId: agentIssueCreationRequests.id,
        userMessage: sql<string | null>`case
          when jsonb_typeof(${heartbeatRuns.resultJson}->'userMessage') = 'string'
          then ${heartbeatRuns.resultJson}->>'userMessage'
          else null
        end`,
        createdAt: heartbeatRuns.createdAt,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .leftJoin(agentIssueCreationRequests, and(
        eq(agentIssueCreationRequests.orgId, heartbeatRuns.orgId),
        eq(agentIssueCreationRequests.runId, heartbeatRuns.id),
      ))
      .where(and(eq(heartbeatRuns.orgId, orgId), eq(heartbeatRuns.status, "failed")))
      .orderBy(desc(heartbeatRuns.updatedAt), desc(heartbeatRuns.createdAt)),
    db
      .select({
        id: agentIssueCreationRequests.id,
        orgId: agentIssueCreationRequests.orgId,
        agentId: agentIssueCreationRequests.agentId,
        runId: agentIssueCreationRequests.runId,
        status: agentIssueCreationRequests.status,
        error: agentIssueCreationRequests.error,
        createdAt: agentIssueCreationRequests.createdAt,
        updatedAt: agentIssueCreationRequests.updatedAt,
      })
      .from(agentIssueCreationRequests)
      .where(and(
        eq(agentIssueCreationRequests.orgId, orgId),
        eq(agentIssueCreationRequests.requestedByUserId, userId),
        inArray(agentIssueCreationRequests.status, ["failed", "cancelled"]),
        isNull(agentIssueCreationRequests.createdIssueId),
      ))
      .orderBy(desc(agentIssueCreationRequests.updatedAt), desc(agentIssueCreationRequests.createdAt)),
  ]);
  const linkedRequestIds = new Set(
    runRows
      .map((run) => run.agentIssueCreationRequestId)
      .filter((requestId): requestId is string => Boolean(requestId)),
  );
  return {
    runRows: runRows as FailedRunSummaryRow[],
    requestRows: requestRows.filter((request) => !linkedRequestIds.has(request.id)),
  };
}

export async function loadFailedRunSummaryData(
  db: Db,
  orgId: string,
  userId: string,
  threadStates?: ThreadStateSource,
): Promise<FailedRunSummaryData> {
  const lastReadAt = await lastReadAtForThread(db, orgId, userId, threadStates);
  const { runRows, requestRows } = await loadFailedRunSummaryRows(db, orgId, userId);
  const failureRows = [...runRows, ...requestRows];
  const itemCount = failureRows.length;
  const latestRow = [...failureRows].sort((a, b) => {
    const aTime = normalizeDate(a.updatedAt ?? a.createdAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bTime = normalizeDate(b.updatedAt ?? b.createdAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
    return bTime - aTime;
  })[0] ?? null;
  const unreadCount = systemUnreadCountSince(failureRows, lastReadAt);
  const latestPreview = latestRow
    ? "agentIssueCreationRequestId" in latestRow
      ? failedRunSummary({
        agentIssueCreationRequestId: latestRow.agentIssueCreationRequestId,
        resultJson: latestRow.userMessage ? { userMessage: latestRow.userMessage } : null,
      })
      : failedAgentIssueRequestSummary(latestRow)
    : null;
  return {
    itemCount,
    summary: systemSummary(
      itemCount,
      normalizeDate(latestRow?.updatedAt ?? latestRow?.createdAt ?? null),
      unreadCount,
      lastReadAt,
      latestPreview,
    ),
  };
}
