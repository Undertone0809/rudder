import { logger } from "../../middleware/logger.js";
import {
  ASSIGNMENT_RUN_RECOVERY_BACKOFF_MS,
  type AssignmentRunGuardrailCheckpoint,
} from "./assignment-run-guardrail.js";

type AssignmentGuardrailCheckpointInput = {
  finalizedRun: { id: string };
  agent: any;
  assignmentGuardrailCheckpoint: AssignmentRunGuardrailCheckpoint;
  assignmentContinuationAttempt: number;
  appendRunEvent: (...args: any[]) => Promise<any>;
  beforeAssignmentRecoveryEnqueue?: (...args: any[]) => Promise<any> | any;
  enqueueRecoveryRun: (...args: any[]) => Promise<any>;
};

export async function handleAssignmentGuardrailCheckpoint({
  finalizedRun,
  agent,
  assignmentGuardrailCheckpoint,
  assignmentContinuationAttempt,
  appendRunEvent,
  beforeAssignmentRecoveryEnqueue,
  enqueueRecoveryRun,
}: AssignmentGuardrailCheckpointInput): Promise<Date | null> {
  const continuationRequired = assignmentContinuationAttempt < 1
    && assignmentGuardrailCheckpoint.automaticContinuationAllowed;
  await appendRunEvent(finalizedRun, {
    eventType: "runtime.assignment_checkpoint",
    stream: "system",
    level: "warn",
    message: "assignment run checkpoint created",
    payload: {
      completed: assignmentGuardrailCheckpoint.completedWorkSummary,
      unresolvedError: assignmentGuardrailCheckpoint.unresolvedError,
      nextRecoveryCommand: assignmentGuardrailCheckpoint.nextRecoveryCommand,
      continuationRequired,
      failureCount: assignmentGuardrailCheckpoint.failureCount,
      unresolvedFailureCount: assignmentGuardrailCheckpoint.unresolvedFailureCount,
      failureClass: assignmentGuardrailCheckpoint.failureClass,
      continuationBlockReason: assignmentGuardrailCheckpoint.continuationBlockReason,
      fingerprint: assignmentGuardrailCheckpoint.fingerprint,
    },
  });
  if (!continuationRequired) return null;

  const recoveryRequestedAt = new Date(Date.now() + ASSIGNMENT_RUN_RECOVERY_BACKOFF_MS);
  let recoveryRun: { id: string } | null = null;
  try {
    await beforeAssignmentRecoveryEnqueue?.(finalizedRun);
    recoveryRun = await enqueueRecoveryRun(finalizedRun, agent, {
      recoveryTrigger: "automatic",
      source: "automation",
      triggerDetail: "system",
      wakeReason: "assignment_failure_budget_continuation",
      requestedByActorType: "system",
      requestedByActorId: null,
      contextPatch: {
        assignmentGuardrailContinuationAttempt: assignmentContinuationAttempt + 1,
        assignmentGuardrailCheckpoint,
        assignmentGuardrailRecovery: {
          attempt: assignmentContinuationAttempt + 1,
          maxAttempts: 1,
          backoffMs: ASSIGNMENT_RUN_RECOVERY_BACKOFF_MS,
          requestedAt: recoveryRequestedAt.toISOString(),
        },
      },
      startImmediately: false,
      notBefore: recoveryRequestedAt,
      suppressSourceAutomationOutput: true,
      now: new Date(),
    });
  } catch (recoveryError) {
    const recoveryErrorMessage = recoveryError instanceof Error
      ? recoveryError.message
      : "Unknown recovery enqueue failure";
    await appendRunEvent(finalizedRun, {
      eventType: "runtime.assignment_recovery_request_failed",
      stream: "system",
      level: "error",
      message: "bounded assignment recovery request failed",
      payload: {
        attempt: assignmentContinuationAttempt + 1,
        maxAttempts: 1,
        failureClass: assignmentGuardrailCheckpoint.failureClass,
        error: recoveryErrorMessage,
      },
    });
    logger.error({ err: recoveryError, runId: finalizedRun.id }, "failed to enqueue bounded assignment recovery");
  }
  if (!recoveryRun) return null;

  await appendRunEvent(finalizedRun, {
    eventType: "runtime.assignment_recovery_requested",
    stream: "system",
    level: "warn",
    message: "bounded assignment recovery requested",
    payload: {
      recoveryRunId: recoveryRun.id,
      attempt: assignmentContinuationAttempt + 1,
      maxAttempts: 1,
      backoffMs: ASSIGNMENT_RUN_RECOVERY_BACKOFF_MS,
      requestedAt: recoveryRequestedAt.toISOString(),
      failureClass: assignmentGuardrailCheckpoint.failureClass,
    },
  }).catch((eventError) => {
    logger.error({ err: eventError, runId: finalizedRun.id }, "failed to record bounded assignment recovery request");
  });
  return recoveryRequestedAt;
}
