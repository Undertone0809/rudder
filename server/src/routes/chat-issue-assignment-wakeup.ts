import type { Db } from "@rudderhq/db";
import { logger } from "../middleware/logger.js";
import type { logActivity } from "../services/activity-log.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";

export type ChatConvertedIssue = {
  id: string;
  orgId: string;
  assigneeAgentId: string | null;
  status: string;
  title: string;
  description?: string | null;
  priority?: string | null;
};

export async function wakeIssueAssigneeAfterChatConversion(input: {
  db: Db;
  heartbeat: IssueAssignmentWakeupDeps;
  issue: ChatConvertedIssue;
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType: "user" | "agent" | "system";
  requestedByActorId: string | null;
  activityAction?: string;
  activityEntityType?: string;
  activityEntityId?: string;
  activityDetails?: Record<string, unknown>;
  logActivityFn?: typeof logActivity;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  try {
    const wakeRun = await queueIssueAssignmentWakeup({
      heartbeat: input.heartbeat,
      issue: input.issue,
      reason: input.reason,
      mutation: input.mutation,
      contextSource: input.contextSource,
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId,
      rethrowOnError: true,
    });

    if (input.activityAction && input.activityEntityType && input.activityEntityId && input.logActivityFn) {
      await input.logActivityFn(input.db, {
        orgId: input.issue.orgId,
        actorType: input.requestedByActorType,
        actorId: input.requestedByActorId ?? "system",
        action: input.activityAction,
        entityType: input.activityEntityType,
        entityId: input.activityEntityId,
        details: {
          issueId: input.issue.id,
          assigneeAgentId: input.issue.assigneeAgentId,
          wakeRunId: wakeRun && typeof wakeRun === "object" && "id" in wakeRun ? wakeRun.id : null,
          ...(input.activityDetails ?? {}),
        },
      });
    }
  } catch (err) {
    logger.warn(
      { err, issueId: input.issue.id, assigneeAgentId: input.issue.assigneeAgentId },
      "failed to wake assignee after chat issue conversion",
    );
    if (input.activityAction && input.activityEntityType && input.activityEntityId && input.logActivityFn) {
      await input.logActivityFn(input.db, {
        orgId: input.issue.orgId,
        actorType: input.requestedByActorType,
        actorId: input.requestedByActorId ?? "system",
        action: input.activityAction.replace(/_queued$/, "_failed"),
        entityType: input.activityEntityType,
        entityId: input.activityEntityId,
        details: {
          issueId: input.issue.id,
          assigneeAgentId: input.issue.assigneeAgentId,
          error: err instanceof Error ? err.message : String(err),
          ...(input.activityDetails ?? {}),
        },
      });
    }
  }
}
