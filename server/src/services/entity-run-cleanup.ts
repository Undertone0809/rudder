import type { Db } from "@rudderhq/db";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  calendarEvents,
  costEvents,
  financeEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@rudderhq/db";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  completeEntityCleanupJob,
  enqueueEntityCleanupJobs,
  type EntityCleanupArtifact,
} from "./entity-cleanup-jobs.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import {
  getWorkspaceOperationLogStore,
  type WorkspaceOperationLogHandle,
} from "./workspace-operation-log-store.js";
import { stopRuntimeServiceForDeletion } from "./workspace-runtime.services.js";

type EntityRunCleanupTarget = {
  orgId: string;
  issueId?: string;
  chatConversationId?: string;
  chatConversationIds?: string[];
  explicitRunIds?: Array<string | null | undefined>;
};

export type EntityRunCleanupArtifacts = {
  runLogs: RunLogHandle[];
  workspaceOperationLogs: WorkspaceOperationLogHandle[];
  runtimeServiceIds: string[];
};

const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const ACTIVE_WAKEUP_STATUSES = [
  "queued",
  "claimed",
  "deferred_agent_paused",
  "deferred_issue_execution",
] as const;

function wakeupEntityCondition(input: EntityRunCleanupTarget) {
  const issueId = input.issueId;
  if (issueId) {
    return sql<boolean>`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`;
  }
  const chatConversationIds = input.chatConversationIds ?? [input.chatConversationId!];
  return or(
    inArray(sql<string>`${agentWakeupRequests.payload}->>'conversationId'`, chatConversationIds),
    inArray(sql<string>`${agentWakeupRequests.payload}->>'chatConversationId'`, chatConversationIds),
  )!;
}

function runEntityCondition(input: EntityRunCleanupTarget, wakeupIds: string[], linkedRunIds: string[]) {
  const issueId = input.issueId;
  const chatConversationIds = input.chatConversationIds ?? [input.chatConversationId!];
  const conditions = issueId
    ? [
      sql<boolean>`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      sql<boolean>`${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId}`,
    ]
    : [
      inArray(heartbeatRuns.chatConversationId, chatConversationIds),
      inArray(sql<string>`${heartbeatRuns.contextSnapshot}->>'conversationId'`, chatConversationIds),
      inArray(sql<string>`${heartbeatRuns.contextSnapshot}->>'chatConversationId'`, chatConversationIds),
    ];
  if (wakeupIds.length > 0) {
    conditions.push(inArray(heartbeatRuns.wakeupRequestId, wakeupIds));
  }
  if (linkedRunIds.length > 0) {
    conditions.push(inArray(heartbeatRuns.id, linkedRunIds));
  }
  return or(...conditions)!;
}

async function discoverEntityRunData(db: Db, input: EntityRunCleanupTarget) {
  const directWakeups = await db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.orgId, input.orgId),
      wakeupEntityCondition(input),
    ));
  const directWakeupIds = directWakeups.map((row) => row.id);

  const entityType = input.issueId ? "issue" : "chat";
  const entityIds = input.issueId
    ? [input.issueId]
    : (input.chatConversationIds ?? [input.chatConversationId!]);
  const activityRunRows = await db
    .select({ runId: activityLog.runId })
    .from(activityLog)
    .where(and(
      eq(activityLog.orgId, input.orgId),
      eq(activityLog.entityType, entityType),
      inArray(activityLog.entityId, entityIds),
      isNotNull(activityLog.runId),
    ));
  const linkedRunIds = [...new Set([
    ...(input.explicitRunIds ?? []).filter((runId): runId is string => Boolean(runId)),
    ...activityRunRows.map((row) => row.runId).filter((runId): runId is string => Boolean(runId)),
  ])];

  const runRows = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      terminalEffectsPending: heartbeatRuns.terminalEffectsPending,
      logStore: heartbeatRuns.logStore,
      logRef: heartbeatRuns.logRef,
      wakeupRequestId: heartbeatRuns.wakeupRequestId,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.orgId, input.orgId),
      runEntityCondition(input, directWakeupIds, linkedRunIds),
    ));

  return { directWakeups, directWakeupIds, runRows };
}

export async function assertNoActiveEntityRunData(
  db: Db,
  input: EntityRunCleanupTarget,
  message: string,
) {
  const { directWakeups, runRows } = await discoverEntityRunData(db, input);
  assertDiscoveredRunDataIsInactive(directWakeups, runRows, message);
}

function assertDiscoveredRunDataIsInactive(
  directWakeups: Array<{ status: string }>,
  runRows: Array<{ status: string; terminalEffectsPending: boolean }>,
  message: string,
) {
  const hasActiveRun = runRows.some((run) =>
    ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number]) ||
    run.terminalEffectsPending === true,
  );
  const hasActiveWakeup = directWakeups.some((wakeup) =>
    ACTIVE_WAKEUP_STATUSES.includes(wakeup.status as (typeof ACTIVE_WAKEUP_STATUSES)[number]),
  );
  if (hasActiveRun || hasActiveWakeup) throw conflict(message);
}

export async function deleteEntityRunData(
  db: Db,
  input: EntityRunCleanupTarget,
  activeConflictMessage: string,
): Promise<EntityRunCleanupArtifacts> {
  await db.execute(
    sql`lock table ${agentWakeupRequests}, ${heartbeatRuns} in share row exclusive mode`,
  );
  const { directWakeups, directWakeupIds, runRows } = await discoverEntityRunData(db, input);
  assertDiscoveredRunDataIsInactive(directWakeups, runRows, activeConflictMessage);
  const runIds = runRows.map((row) => row.id);

  const runLinkedWakeups = runIds.length > 0
    ? await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.orgId, input.orgId),
        inArray(agentWakeupRequests.runId, runIds),
      ))
    : [];
  const wakeupIds = [...new Set([
    ...directWakeupIds,
    ...runRows.map((row) => row.wakeupRequestId).filter((id): id is string => Boolean(id)),
    ...runLinkedWakeups.map((row) => row.id),
  ])];

  const workspaceOperationRows = runIds.length > 0
    ? await db
      .select({
        id: workspaceOperations.id,
        logStore: workspaceOperations.logStore,
        logRef: workspaceOperations.logRef,
      })
      .from(workspaceOperations)
      .where(and(
        eq(workspaceOperations.orgId, input.orgId),
        inArray(workspaceOperations.heartbeatRunId, runIds),
      ))
    : [];

  const ownedRuntimeServiceRows = runIds.length > 0 || input.issueId
    ? await db
      .select({ id: workspaceRuntimeServices.id })
      .from(workspaceRuntimeServices)
      .where(and(
        eq(workspaceRuntimeServices.orgId, input.orgId),
        eq(workspaceRuntimeServices.scopeType, "run"),
        or(
          ...(runIds.length > 0
            ? [
              inArray(workspaceRuntimeServices.startedByRunId, runIds),
              inArray(workspaceRuntimeServices.scopeId, runIds),
            ]
            : []),
          ...(input.issueId ? [eq(workspaceRuntimeServices.issueId, input.issueId)] : []),
        )!,
      ))
    : [];
  const ownedRuntimeServiceIds = ownedRuntimeServiceRows.map((row) => row.id);
  await enqueueEntityCleanupJobs(db, input.orgId, [
    ...runRows.flatMap((row): EntityCleanupArtifact[] =>
      row.logStore === "local_file" && row.logRef
        ? [{ artifactType: "run_log", artifactRef: row.logRef }]
        : []),
    ...workspaceOperationRows.flatMap((row): EntityCleanupArtifact[] =>
      row.logStore === "local_file" && row.logRef
        ? [{ artifactType: "workspace_operation_log", artifactRef: row.logRef }]
        : []),
    ...ownedRuntimeServiceIds.map((artifactRef): EntityCleanupArtifact => ({
      artifactType: "runtime_service",
      artifactRef,
    })),
  ]);

  if (input.issueId) {
    await db.delete(calendarEvents).where(and(
      eq(calendarEvents.orgId, input.orgId),
      eq(calendarEvents.issueId, input.issueId),
    ));
  }
  if (runIds.length > 0) {
    await db.delete(calendarEvents).where(and(
      eq(calendarEvents.orgId, input.orgId),
      inArray(calendarEvents.heartbeatRunId, runIds),
    ));
    await db.update(costEvents).set({ heartbeatRunId: null }).where(and(
      eq(costEvents.orgId, input.orgId),
      inArray(costEvents.heartbeatRunId, runIds),
    ));
    await db.update(financeEvents).set({ heartbeatRunId: null }).where(and(
      eq(financeEvents.orgId, input.orgId),
      inArray(financeEvents.heartbeatRunId, runIds),
    ));
    await db.update(agentTaskSessions).set({ lastRunId: null }).where(and(
      eq(agentTaskSessions.orgId, input.orgId),
      inArray(agentTaskSessions.lastRunId, runIds),
    ));
    await db.delete(activityLog).where(and(
      eq(activityLog.orgId, input.orgId),
      inArray(activityLog.runId, runIds),
    ));
    await db.delete(workspaceOperations).where(and(
      eq(workspaceOperations.orgId, input.orgId),
      inArray(workspaceOperations.heartbeatRunId, runIds),
    ));
    if (ownedRuntimeServiceIds.length > 0) {
      await db.delete(workspaceRuntimeServices).where(and(
        eq(workspaceRuntimeServices.orgId, input.orgId),
        inArray(workspaceRuntimeServices.id, ownedRuntimeServiceIds),
      ));
    }
    await db.delete(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.orgId, input.orgId),
      inArray(heartbeatRunEvents.runId, runIds),
    ));
    await db.delete(heartbeatRuns).where(and(
      eq(heartbeatRuns.orgId, input.orgId),
      inArray(heartbeatRuns.id, runIds),
    ));
  }
  if (wakeupIds.length > 0) {
    await db.delete(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.orgId, input.orgId),
      inArray(agentWakeupRequests.id, wakeupIds),
    ));
  }

  return {
    runLogs: runRows.flatMap((row) =>
      row.logStore === "local_file" && row.logRef
        ? [{ store: "local_file" as const, logRef: row.logRef }]
        : []),
    workspaceOperationLogs: workspaceOperationRows.flatMap((row) =>
      row.logStore === "local_file" && row.logRef
        ? [{ store: "local_file" as const, logRef: row.logRef }]
        : []),
    runtimeServiceIds: ownedRuntimeServiceIds,
  };
}

export async function removeEntityRunLogArtifacts(
  db: Db,
  orgId: string,
  artifacts: EntityRunCleanupArtifacts,
) {
  const runLogStore = getRunLogStore();
  const workspaceOperationLogStore = getWorkspaceOperationLogStore();
  const removals: Array<{ artifact: EntityCleanupArtifact; remove: () => Promise<void> }> = [
    ...artifacts.runtimeServiceIds.map((serviceId) => ({
      artifact: { artifactType: "runtime_service" as const, artifactRef: serviceId },
      remove: () => stopRuntimeServiceForDeletion(serviceId),
    })),
    ...artifacts.runLogs.map((handle) => ({
      artifact: { artifactType: "run_log" as const, artifactRef: handle.logRef },
      remove: () => runLogStore.remove(handle),
    })),
    ...artifacts.workspaceOperationLogs.map((handle) => ({
      artifact: { artifactType: "workspace_operation_log" as const, artifactRef: handle.logRef },
      remove: () => workspaceOperationLogStore.remove(handle),
    })),
  ];
  await Promise.all(removals.map(async ({ artifact, remove }) => {
    try {
      await remove();
      await completeEntityCleanupJob(db, orgId, artifact);
    } catch (error) {
      logger.warn({ err: error }, "failed to remove deleted entity run log artifact");
    }
  }));
}
