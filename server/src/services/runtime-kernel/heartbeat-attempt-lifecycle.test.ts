import { beforeEach, describe, expect, it, vi } from "vitest";

const beginAttempt = vi.hoisted(() => vi.fn());
const finishAttempt = vi.hoisted(() => vi.fn());
const checkpointAttempt = vi.hoisted(() => vi.fn());
const issueAuthority = vi.hoisted(() => vi.fn());

vi.mock("./heartbeat-attempt-ledger.js", () => ({
  beginHeartbeatRunAttempt: beginAttempt,
  checkpointHeartbeatRunAttempt: checkpointAttempt,
  finishHeartbeatRunAttempt: finishAttempt,
}));
vi.mock("./native-process-authority.js", () => ({
  issueNativeProcessAuthorityForAttempt: issueAuthority,
  selectNativeProcessAuthority: (type: string, authority: unknown) => type === "process" ? authority : undefined,
}));

import { createHeartbeatAttemptLifecycle } from "./heartbeat-attempt-lifecycle.js";

const run = {
  id: "run-1",
  orgId: "org-1",
  agentId: "agent-1",
  executionOwnerToken: "execution-owner",
  executionLeaseExpiresAt: new Date(Date.now() + 60_000),
};
const attempt = {
  index: 0,
  agentRuntimeType: "process",
  model: "model-1",
  config: null,
  isFallback: false,
  fallbackIndex: null,
  totalFallbacks: 0,
};
const authority = {
  authorityVersion: 1,
  runtimeIdentity: { organizationId: "org-1", agentId: "agent-1", runId: "run-1" },
  ownership: { epoch: 1, fence: "execution-owner" },
  lease: { owner: "execution-owner", issuedAtMillis: 1, expiresAtMillis: 60_000 },
  attempt: 1,
  requestId: "request-1",
  bindingDigest: "a".repeat(64),
  receiptContext: { runtimeRoot: "/tmp/rudder-receipts", ownerToken: "receipt-owner" },
};

function createLifecycle() {
  const persistAttempt = vi.fn(async (_label: string, operation: () => Promise<unknown>) => operation());
  const setParser = vi.fn();
  const lifecycle = createHeartbeatAttemptLifecycle({
    db: {} as never,
    run,
    agentRuntimeType: "process",
    attemptStride: 2,
    recoveryAttemptOrdinal: 1,
    resumeSource: "pristine_replay",
    persistAttempt,
    setStdoutTranscriptParser: setParser,
  });
  return { lifecycle, persistAttempt, setParser };
}

describe("heartbeat attempt lifecycle", () => {
  beforeEach(() => {
    beginAttempt.mockReset().mockResolvedValue({ id: "attempt-row-1", attemptIndex: 2 });
    finishAttempt.mockReset().mockResolvedValue({});
    checkpointAttempt.mockReset().mockResolvedValue({});
    issueAuthority.mockReset().mockReturnValue(authority);
  });

  it("starts a durable attempt with the recovery checkpoint and parser", async () => {
    const { lifecycle, persistAttempt, setParser } = createLifecycle();
    const parser = vi.fn();

    await lifecycle.onAttemptStart(attempt, { type: "process", parseStdoutLine: parser });

    expect(beginAttempt).toHaveBeenCalledWith({}, expect.objectContaining({
      attemptIndex: 2,
      checkpointJson: expect.objectContaining({
        runtimeAttempt: expect.objectContaining({
          phase: "executing",
          networkWaitCount: 1,
        }),
      }),
    }));
    expect(persistAttempt).toHaveBeenCalledWith("started", expect.any(Function));
    expect(setParser).toHaveBeenCalledWith(parser);
    expect(lifecycle.getActiveAttemptSpec()).toMatchObject({
      index: 0,
      ledgerIndex: 2,
      runtimeType: "process",
    });
  });

  it("records authority and terminal failure checkpoints against the same ref", async () => {
    const { lifecycle } = createLifecycle();
    await lifecycle.onAttemptStart(attempt, { type: "process" });
    const issued = await lifecycle.issueNativeProcessAuthority(attempt, { type: "process" });

    expect(issued).toBe(authority);
    expect(issueAuthority).toHaveBeenCalledWith(expect.objectContaining({
      run,
      attemptIndex: 2,
    }));
    expect(checkpointAttempt).toHaveBeenCalledWith(
      {},
      { id: "attempt-row-1", attemptIndex: 2 },
      expect.objectContaining({
        runtimeAttempt: expect.objectContaining({
          phase: "executing",
          authority: expect.objectContaining({ requestId: "request-1" }),
        }),
      }),
    );

    await lifecycle.onAttemptFailure(attempt, {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "process_failed",
      errorMessage: "failed",
    });

    expect(finishAttempt).toHaveBeenCalledWith({}, { id: "attempt-row-1", attemptIndex: 2 }, expect.objectContaining({
      status: "failed",
      errorCode: "process_failed",
      checkpointJson: expect.objectContaining({
        runtimeAttempt: expect.objectContaining({ phase: "failed" }),
      }),
    }));
    expect(lifecycle.takeActiveAttemptRef()).toBeNull();
  });

  it("clears a prior process authority before a non-process fallback starts", async () => {
    const { lifecycle } = createLifecycle();
    await lifecycle.onAttemptStart(attempt, { type: "process" });
    await lifecycle.issueNativeProcessAuthority(attempt, { type: "process" });
    await lifecycle.onAttemptStart({
      ...attempt,
      index: 1,
      agentRuntimeType: "remote",
      isFallback: true,
      fallbackIndex: 0,
    }, { type: "remote" });

    expect(beginAttempt.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      checkpointJson: expect.objectContaining({
        runtimeAttempt: expect.objectContaining({ authority: null }),
      }),
    }));
  });

  it("merges waiting evidence and consumes the active ref exactly once", async () => {
    const { lifecycle } = createLifecycle();
    await lifecycle.onAttemptStart(attempt, { type: "process" });
    await lifecycle.issueNativeProcessAuthority(attempt, { type: "process" });
    const checkpoint = { code: "provider_transport_unavailable", attemptIndex: 0 };

    const waiting = lifecycle.buildWaitingCheckpoint({
      checkpoint,
      recoveryAttemptOrdinal: 2,
      resumeSource: "same_session",
      fallbackAttemptIndex: 5,
    });

    expect(waiting).toMatchObject({
      code: "provider_transport_unavailable",
      runtimeAttempt: expect.objectContaining({
        phase: "waiting_for_network",
        networkWaitCount: 2,
        retry: expect.objectContaining({ resumeSource: "same_session" }),
      }),
    });
    expect(lifecycle.takeActiveAttemptRef()).toEqual({ id: "attempt-row-1", attemptIndex: 2 });
    expect(lifecycle.takeActiveAttemptRef()).toBeNull();
  });
});
