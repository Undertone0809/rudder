import { describe, expect, it } from "vitest";
import {
  buildRuntimeAttemptCheckpoint,
  mergeRuntimeAttemptCheckpoint,
} from "./runtime-attempt-adapter.js";

const base = {
  orgId: "org-1",
  runId: "run-1",
  agentId: "agent-1",
  executionOwnerToken: "owner-1",
  executionLeaseExpiresAt: new Date("2026-09-11T12:00:00.000Z"),
  attemptIndex: 2,
  fallbackIndex: 1,
  runtimeType: "process",
  model: "model-1",
  isFallback: true,
  recoveryAttemptOrdinal: 1,
  resumeSource: "same_session" as const,
};

describe("runtime attempt durable adapter", () => {
  it("persists identity, lease/fence, retry, idempotency, and owner recovery fields", () => {
    const checkpoint = buildRuntimeAttemptCheckpoint({
      ...base,
      phase: "executing",
    });

    expect(checkpoint.runtimeAttempt).toMatchObject({
      protocolVersion: 1,
      identity: { organizationId: "org-1", runId: "run-1", agentId: "agent-1" },
      attempt: { attempt: 3 },
      phase: "executing",
      networkWaitCount: 1,
      idempotencyKey: "run-1:2:1",
      lease: { ownerId: "owner-1", epoch: 3 },
      retry: { recoveryAttemptOrdinal: 1, resumeSource: "same_session", fallbackIndex: 1 },
      ownerRecovery: { executionOwnerToken: "owner-1" },
    });
  });

  it("keeps existing network evidence while updating the private runtime projection", () => {
    const checkpoint = buildRuntimeAttemptCheckpoint({
      ...base,
      phase: "waiting_for_network",
      evidence: { submissionPhase: "indeterminate" },
    });
    const merged = mergeRuntimeAttemptCheckpoint(
      { code: "provider_transport_unavailable", networkWait: true },
      checkpoint,
    );

    expect(merged).toMatchObject({
      code: "provider_transport_unavailable",
      networkWait: true,
      runtimeAttempt: { phase: "waiting_for_network", evidence: { submissionPhase: "indeterminate" } },
    });
  });
});
