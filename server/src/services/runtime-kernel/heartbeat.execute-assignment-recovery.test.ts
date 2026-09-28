import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssignmentRunGuardrailCheckpoint } from "./assignment-run-guardrail.js";
import { handleAssignmentGuardrailCheckpoint } from "./heartbeat.execute-assignment-recovery.js";

vi.mock("../../middleware/logger.js", () => ({ logger: { error: vi.fn() } }));

const checkpoint: AssignmentRunGuardrailCheckpoint = {
  reason: "unresolved_failure_budget",
  failureCount: 4,
  unresolvedFailureCount: 4,
  consecutiveFailureCount: 4,
  failureClass: "command_failure",
  fingerprint: "tool:fingerprint",
  toolName: "bash",
  unresolvedError: "command failed",
  nextRecoveryCommand: "inspect command output",
  automaticContinuationAllowed: true,
  continuationBlockReason: null,
  completedWorkSummary: "completed one task",
};

describe("assignment guardrail checkpoint handling", () => {
  const finalizedRun = { id: "run-1" };
  const agent = { id: "agent-1" };
  let events: Array<Record<string, any>>;

  beforeEach(() => {
    events = [];
  });

  it("records the checkpoint before requesting bounded recovery", async () => {
    const actions: string[] = [];
    const appendRunEvent = async (_run: unknown, event: Record<string, any>) => {
      events.push(event);
      actions.push(`event:${event.eventType}`);
    };
    let recoveryOptions: Record<string, any> | undefined;

    const requestedAt = await handleAssignmentGuardrailCheckpoint({
      finalizedRun,
      agent,
      assignmentGuardrailCheckpoint: checkpoint,
      assignmentContinuationAttempt: 0,
      appendRunEvent,
      beforeAssignmentRecoveryEnqueue: async () => { actions.push("before-enqueue"); },
      enqueueRecoveryRun: async (_run: unknown, _agent: unknown, options: Record<string, any>) => {
        actions.push("enqueue");
        recoveryOptions = options;
        return { id: "recovery-1" };
      },
    });

    expect(actions).toEqual([
      "event:runtime.assignment_checkpoint",
      "before-enqueue",
      "enqueue",
      "event:runtime.assignment_recovery_requested",
    ]);
    expect(events[0]?.payload).toMatchObject({
      completed: checkpoint.completedWorkSummary,
      continuationRequired: true,
      failureClass: checkpoint.failureClass,
    });
    expect(recoveryOptions).toMatchObject({
      recoveryTrigger: "automatic",
      source: "automation",
      wakeReason: "assignment_failure_budget_continuation",
      startImmediately: false,
      suppressSourceAutomationOutput: true,
      contextPatch: {
        assignmentGuardrailContinuationAttempt: 1,
        assignmentGuardrailCheckpoint: checkpoint,
        assignmentGuardrailRecovery: { attempt: 1, maxAttempts: 1 },
      },
    });
    expect(requestedAt).toBe(recoveryOptions?.notBefore);
    expect(requestedAt).toBeInstanceOf(Date);
  });

  it("records the checkpoint without enqueueing after the continuation limit", async () => {
    const enqueueRecoveryRun = vi.fn();

    const requestedAt = await handleAssignmentGuardrailCheckpoint({
      finalizedRun,
      agent,
      assignmentGuardrailCheckpoint: checkpoint,
      assignmentContinuationAttempt: 1,
      appendRunEvent: async (_run: unknown, event: Record<string, any>) => { events.push(event); },
      enqueueRecoveryRun,
    });

    expect(requestedAt).toBeNull();
    expect(enqueueRecoveryRun).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.continuationRequired).toBe(false);
  });

  it("records enqueue failures and does not schedule recovery", async () => {
    const requestedAt = await handleAssignmentGuardrailCheckpoint({
      finalizedRun,
      agent,
      assignmentGuardrailCheckpoint: checkpoint,
      assignmentContinuationAttempt: 0,
      appendRunEvent: async (_run: unknown, event: Record<string, any>) => { events.push(event); },
      enqueueRecoveryRun: async () => { throw new Error("queue unavailable"); },
    });

    expect(requestedAt).toBeNull();
    expect(events.map((event) => event.eventType)).toEqual([
      "runtime.assignment_checkpoint",
      "runtime.assignment_recovery_request_failed",
    ]);
    expect(events[1]?.payload).toMatchObject({
      error: "queue unavailable",
      failureClass: checkpoint.failureClass,
    });
  });
});
