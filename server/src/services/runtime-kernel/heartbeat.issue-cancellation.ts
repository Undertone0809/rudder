// @ts-nocheck
import { heartbeatRuns, issues } from "@rudderhq/db";
import type { Db } from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { getAgentIssueCreationRequestIdFromRunContext } from "../agent-issue-creation.js";
import { logger } from "../../middleware/logger.js";
import { finishLatestHeartbeatRunAttempt } from "./heartbeat-attempt-ledger.js";
import * as heartbeatCore from "./heartbeat.core.js";
import {
  transitionHeartbeatRunToTerminalInTransaction,
  type TerminalEffectIntent,
} from "./heartbeat.terminal.js";

const { isIssueCommentMentionWake } = heartbeatCore;

export function createHeartbeatIssueCancellationHandlers(context: any) {
  const {
    db,
    agentIssueCreationSvc,
    appendRunEvent,
    completeTerminalControlEffects,
    publishRunStatus,
  } = context;

  async function cancelQueuedRunWithinClaimTransaction(
    tx: any,
    currentRun: any,
    reason: string,
  ) {
    const contextRequestId = getAgentIssueCreationRequestIdFromRunContext(currentRun.contextSnapshot);
    const agentIssueCreationSettlement = contextRequestId
      ? {
          orgId: currentRun.orgId,
          agentId: currentRun.agentId,
          runId: currentRun.id,
          requestId: contextRequestId,
        } satisfies NonNullable<TerminalEffectIntent["agentIssueCreationSettlement"]>
      : await agentIssueCreationSvc
          .getSettlementIntentForRun(currentRun.orgId, currentRun.agentId, currentRun.id)
          .catch((error: unknown) => {
            logger.warn(
              { err: error, runId: currentRun.id },
              "failed to resolve Agent Issue creation settlement terminal effect",
            );
            return null;
          });
    const agentIssueCreationNotification = await agentIssueCreationSvc
      .getNotificationIntentForRun(currentRun.orgId, currentRun.agentId, currentRun.id)
      .catch((error: unknown) => {
        logger.warn(
          { err: error, runId: currentRun.id },
          "failed to resolve Agent Issue creation notification terminal effect",
        );
        return null;
      });

    return transitionHeartbeatRunToTerminalInTransaction(tx as Db, {
      runId: currentRun.id,
      status: "cancelled",
      patch: {
        finishedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
        processExitedAt: new Date(),
      },
      expectedStatuses: ["queued"],
      terminalEffectsIntent: {
        version: 1,
        ...(agentIssueCreationSettlement ? { agentIssueCreationSettlement } : {}),
        ...(agentIssueCreationNotification ? { agentIssueCreationNotification } : {}),
      },
    });
  }

  async function getQueuedIssueCancellationReason(input: {
    tx: any;
    issueId: string | null;
    currentIssue: { id: string; status: string; executionCancellationAt: Date | null } | null;
    currentRun: { id: string; orgId: string };
    currentContext: Record<string, unknown>;
    wakeup: { reason: string | null; payload: unknown } | null;
  }) {
    const currentCommentMentionWake = isIssueCommentMentionWake({
      reason: readWakeReason(input.currentContext, input.wakeup),
      contextSnapshot: input.currentContext,
      payload: input.wakeup?.payload,
    });
    const queuedBeforeIssueCancellation = input.currentIssue?.executionCancellationAt
      ? await input.tx
          .select({
            fenced: sql<boolean>`${heartbeatRuns.createdAt} <= ${issues.executionCancellationAt}`,
          })
          .from(heartbeatRuns)
          .innerJoin(issues, and(
            eq(issues.id, input.currentIssue.id),
            eq(issues.orgId, input.currentRun.orgId),
          ))
          .where(eq(heartbeatRuns.id, input.currentRun.id))
          .then((rows: Array<{ fenced: boolean }>) => rows[0]?.fenced === true)
      : false;

    if (
      input.issueId
      && (
        !input.currentIssue
        || queuedBeforeIssueCancellation
        || ((input.currentIssue.status === "done" || input.currentIssue.status === "cancelled") && !currentCommentMentionWake)
      )
    ) {
      return input.currentIssue
        ? "Cancelled because the linked issue is no longer actionable"
        : "Cancelled because the linked issue no longer exists";
    }
    return null;
  }

  async function finishClaimedRunCancellation(claimed: any) {
    publishRunStatus(claimed);
    await finishLatestHeartbeatRunAttempt(db, claimed.id, {
      status: "cancelled",
      usageDeltaJson: claimed.usageJson,
      costUsd: claimed.usageJson?.costUsd,
      sessionDisplayId: claimed.sessionIdAfter,
      sessionParamsJson: claimed.sessionParamsAfterJson,
      errorCode: claimed.errorCode,
      error: claimed.error,
      finishedAt: claimed.finishedAt ?? new Date(),
    }).catch((error: unknown) => {
      logger.warn({ err: error, runId: claimed.id }, "failed to persist heartbeat attempt terminal state");
      return null;
    });
    await appendRunEvent(claimed, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "run cancelled",
    });
    await completeTerminalControlEffects(claimed, { startNext: false });
  }

  return {
    cancelQueuedRunWithinClaimTransaction,
    getQueuedIssueCancellationReason,
    finishClaimedRunCancellation,
  };
}

function readWakeReason(
  context: Record<string, unknown>,
  wakeup: { reason: string | null } | null,
) {
  const contextReason = context.wakeReason;
  return typeof contextReason === "string" && contextReason.trim().length > 0
    ? contextReason
    : wakeup?.reason;
}
