import { describe, expect, it, vi } from "vitest";
import { assertAcceptedClaudeForkIsNewInput, settleAcceptedClaudeForkRecovery } from "./chat-assistant.claude-fork-recovery.js";

const run = {
  id: "run-1", orgId: "org-1", agentId: "agent-1",
  runtimeSpanId: "span-1", runtimeSpanOwnerToken: "owner-2", runtimeSpanAttemptEpoch: 2,
};
const child = {
  session: { sessionId: "child-session", sessionDisplayId: "child-session", sessionParams: { sessionId: "child-session" } },
  boundary: "child-assistant", sourceBoundary: "parent-assistant", continuity: "native" as const,
};
const acceptedState = { __rudderNativeForkIntent: {
  version: 1, intentId: "intent-1", idempotencyKey: "side-chat:conversation-1", status: "accepted",
  source: {
    orgId: "org-1", sourceConversationId: "parent-1", sourceRunId: "parent-run",
    sourceSpanId: "parent-span", sourceBoundaryRef: "parent-assistant",
    selectorJson: { kind: "claude_chain", sessionId: "parent-session", throughInclusiveUuid: "parent-assistant" },
  },
  target: {
    orgId: "org-1", bindingId: "binding-1", segmentId: "segment-1", bindingEpoch: 0,
    runtimeType: "claude_local", hostId: "local", profileId: "default",
    workspaceBindingId: null, capabilityRevision: "revision-1",
  },
  runFence: { runId: "run-1", spanId: "span-1", ownerToken: "owner-1", attemptEpoch: 1 },
  child, reason: null, reconciliation: "not_required", reconciliationNote: null,
  createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
} };

function dbWithOriginalMessage(userMessageId?: string) {
  const rows = userMessageId ? [{ contextSnapshot: { userMessageId } }] : [];
  const query = { limit: vi.fn().mockReturnValue(Promise.resolve(rows)) };
  const db = { select: vi.fn().mockReturnValue({ from: () => ({ where: () => query }) }) };
  return { db: db as any, query };
}

describe("accepted Claude fork recovery", () => {
  it("blocks an accepted original message but lets the next distinct message resume", async () => {
    const { db } = dbWithOriginalMessage("message-1");
    const base = { db, orgId: "org-1", conversationId: "conversation-1", bindingId: "binding-1", providerState: acceptedState };
    await expect(assertAcceptedClaudeForkIsNewInput({ ...base, userMessageId: "message-1" }))
      .rejects.toThrow("same-message replay is blocked");
    await expect(assertAcceptedClaudeForkIsNewInput({ ...base, userMessageId: "message-2" }))
      .resolves.toBeUndefined();
  });

  it("fails closed when the accepted Run's original message is missing", async () => {
    const { db } = dbWithOriginalMessage();
    await expect(assertAcceptedClaudeForkIsNewInput({
      db, orgId: "org-1", conversationId: "conversation-1", bindingId: "binding-1",
      providerState: acceptedState, userMessageId: "message-2",
    })).rejects.toThrow("same-message replay is blocked");
  });

  it("blocks a new message when a descriptor-only fork was left unresolved", async () => {
    const rows = [{ contextSnapshot: { sideChatRuntimeAdmission: { deferredForkDescriptor: { version: 1 } } } }];
    const db = { select: () => ({ from: () => ({ innerJoin: () => ({
      where: () => ({ limit: () => Promise.resolve(rows) }),
    }) }) }) } as any;
    await expect(assertAcceptedClaudeForkIsNewInput({
      db, orgId: "org-1", conversationId: "conversation-1", bindingId: "binding-1",
      providerState: null, userMessageId: "message-2",
    })).rejects.toThrow("unresolved deferred fork");
  });

  it("records an exact partial boundary and terminal failure without calling the provider", async () => {
    const finalize = vi.fn().mockResolvedValue({});
    await settleAcceptedClaudeForkRecovery({
      run, child, sourceBoundaryRef: "parent-assistant", finalize,
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", errorCode: "claude_fork_completion_unresolved",
      nativeExecution: { spanId: "span-1", error: true, result: expect.objectContaining({
        sessionId: "child-session", submissionPhase: "accepted", errorMessage: expect.stringContaining("Do not retry"),
        resultJson: { providerTurnId: "child-assistant", startExclusiveUuid: "parent-assistant",
          transcriptBoundary: { status: "unknown" } },
      }) },
      attempt: expect.objectContaining({ submissionPhase: "accepted", providerTurnId: "child-assistant" }),
      resultJson: expect.objectContaining({ recoverable: false, nativeCompletion: "partial" }),
    }));
  });

  it("cannot finalize when the recovered Run lost its owner fence", async () => {
    const finalize = vi.fn().mockRejectedValue(new Error("stale owner"));
    await expect(settleAcceptedClaudeForkRecovery({
      run, child, sourceBoundaryRef: "parent-assistant", finalize,
    })).rejects.toThrow("stale owner");
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});
