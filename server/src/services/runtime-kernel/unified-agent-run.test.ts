import { describe, expect, it } from "vitest";
import {
  UNIFIED_AGENT_RUN_SCENES,
  UnifiedAgentRunContractError,
  createUnifiedAgentRunLedger,
  normalizeUnifiedSessionIntent,
} from "./unified-agent-run.js";

function clock() {
  let now = new Date("2026-09-22T00:00:00.000Z");
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function admission(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-1",
    agentId: "agent-1",
    scene: "chat" as const,
    target: { type: "chat_conversation" as const, id: "conversation-1" },
    idempotencyKey: "turn-1",
    runtimeType: "codex_local",
    sessionIntent: { kind: "resume" as const, reuseScope: "explicit" as const, sessionId: "thread-1" },
    ...overrides,
  };
}

describe("unified agent run contract", () => {
  it("normalizes an already normalized fresh session intent idempotently", () => {
    const fresh = {
      kind: "fresh" as const,
      reuseScope: "none" as const,
      sourceRunId: null,
      sessionId: null,
      sessionParams: null,
    };
    expect(normalizeUnifiedSessionIntent({ kind: "fresh" })).toEqual(fresh);
    expect(normalizeUnifiedSessionIntent(fresh)).toEqual(fresh);
  });

  it("covers the product scenes and normalizes session intent", () => {
    expect(UNIFIED_AGENT_RUN_SCENES).toEqual([
      "chat",
      "side_chat",
      "issue",
      "review",
      "automation",
      "heartbeat",
      "delegation",
    ]);
    expect(createUnifiedAgentRunLedger().submit(admission({ scene: "delegation" })).entry.scene)
      .toBe("delegation");
    expect(normalizeUnifiedSessionIntent({
      kind: "fork",
      sourceRunId: "run-1",
      sourceBoundaryRef: "turn-3",
      sessionParams: { threadId: "thread-2" },
    })).toEqual({
      kind: "fork",
      reuseScope: "explicit",
      sourceRunId: "run-1",
      sourceBoundaryRef: "turn-3",
      sessionId: null,
      sessionParams: { threadId: "thread-2" },
    });
    expect(() => normalizeUnifiedSessionIntent({
      kind: "fork",
      sourceRunId: "run-1",
      sourceBoundaryRef: "",
    })).toThrow(UnifiedAgentRunContractError);
  });

  it("deduplicates repeated admission and rejects divergent reuse of the key", () => {
    const ledger = createUnifiedAgentRunLedger({ defaultLeaseMs: 1_000 });
    const first = ledger.submit(admission());
    const duplicate = ledger.submit(admission());

    expect(first.created).toBe(true);
    expect(first.entry.ownerFence.id).toBe(first.entry.span.id);
    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.runId).toBe(first.entry.runId);
    expect(duplicate.entry.attempt.ref.id).toBe(first.entry.attempt.ref.id);

    expect(() => ledger.submit(admission({ target: { type: "chat_conversation", id: "conversation-2" } })))
      .toThrow("idempotency key turn-1 was already admitted");
  });

  it("blocks retry after acceptance-unknown until the provider is reconciled", () => {
    const ledger = createUnifiedAgentRunLedger();
    const admitted = ledger.submit(admission());
    const fence = admitted.entry.ownerFence;

    const unknown = ledger.markAcceptanceUnknown(admitted.entry.runId, fence, {
      phase: "indeterminate",
      reason: "transport closed after submission",
    });
    expect(unknown).toMatchObject({
      ok: true,
      value: {
        state: "acceptance_unknown",
        retry: "blocked_until_reconciled",
      },
    });

    expect(() => ledger.beginAttempt(admitted.entry.runId, fence, {
      attemptIndex: 1,
      runtimeType: "codex_local",
      resumeSource: "pristine_replay",
    })).toThrow("reconciling provider acceptance");
    expect(() => ledger.acceptSubmission(admitted.entry.runId, fence)).toThrow("reconcile before accepting or retrying");

    const reconciled = ledger.reconcileAcceptance(admitted.entry.runId, fence, {
      state: "accepted",
      providerTurnId: "turn-3",
    });
    expect(reconciled).toMatchObject({
      ok: true,
      value: {
        state: "accepted",
        providerTurnId: "turn-3",
        retry: "not_allowed",
      },
    });
  });

  it("fences a late owner after an interleaved lease claim", () => {
    const time = clock();
    const ledger = createUnifiedAgentRunLedger({ now: time.now, defaultLeaseMs: 100 });
    const admitted = ledger.submit(admission());
    const oldFence = admitted.entry.ownerFence;

    time.advance(101);
    const claimed = ledger.claimLease(admitted.entry.runId, { ownerToken: "owner-b" });
    expect(claimed).toMatchObject({
      ok: true,
      value: { id: admitted.entry.ownerFence.id, ownerToken: "owner-b", attemptEpoch: 2 },
    });
    if (!claimed.ok) throw new Error("expected the replacement owner to claim the expired lease");

    expect(ledger.finishRun(admitted.entry.runId, oldFence, "succeeded"))
      .toEqual({ ok: false, reason: "stale_owner" });
    expect(ledger.finishRun(admitted.entry.runId, claimed.value, "succeeded"))
      .toMatchObject({ ok: true, value: { status: "succeeded" } });
  });

  it("keeps interleaved attempt/span updates on the current owner fence", () => {
    const time = clock();
    const ledger = createUnifiedAgentRunLedger({ now: time.now, defaultLeaseMs: 100 });
    const admitted = ledger.submit(admission({ idempotencyKey: "turn-interleaved" }));
    const oldFence = admitted.entry.ownerFence;

    expect(ledger.acceptSubmission(admitted.entry.runId, oldFence, { providerTurnId: "turn-1" }).ok).toBe(true);
    expect(ledger.finishAttempt(admitted.entry.runId, oldFence, "failed").ok).toBe(true);
    expect(ledger.beginAttempt(admitted.entry.runId, oldFence, {
      attemptIndex: 1,
      runtimeType: "codex_local",
      isFallback: true,
      fallbackIndex: 1,
      resumeSource: "same_session",
    }).ok).toBe(true);

    time.advance(101);
    const claimed = ledger.claimLease(admitted.entry.runId, { ownerToken: "owner-late" });
    if (!claimed.ok) throw new Error("expected the replacement owner to claim the expired lease");

    expect(ledger.sealSpan(admitted.entry.runId, oldFence, { completeness: "partial" }))
      .toEqual({ ok: false, reason: "stale_owner" });
    expect(ledger.sealSpan(admitted.entry.runId, claimed.value, {
      completeness: "complete",
      sourceRevision: "native-revision-2",
    })).toMatchObject({ ok: true, value: { state: "sealed", completeness: "complete" } });
    expect(ledger.get(admitted.entry.runId)?.attempt.ref.attemptIndex).toBe(1);
  });

  it.each(["partial", "unknown", "missing", "terminal_only"] as const)(
    "does not mark a successful execution complete when its native transcript boundary is %s",
    (boundaryStatus) => {
      const ledger = createUnifiedAgentRunLedger();
      const admitted = ledger.submit(admission());
      const sealed = ledger.recordExecutionResult(admitted.entry.runId, admitted.entry.ownerFence, {
        result: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "native-session-1",
          resultJson: { transcriptBoundary: { status: boundaryStatus } },
        },
      });

      expect(sealed).toMatchObject({
        ok: true,
        value: { state: "unresolved", completeness: "partial" },
      });
    },
  );

  it("does not complete a span when a successful native result has only a provider turn id", () => {
    const ledger = createUnifiedAgentRunLedger();
    const admitted = ledger.submit(admission({ runtimeType: "opencode_local" }));
    const result = ledger.recordExecutionResult(admitted.entry.runId, admitted.entry.ownerFence, {
      result: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: null,
        providerTurnId: "provider-assistant-r1",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { state: "unresolved", completeness: "unknown" },
    });
  });

  it("does not mutate returned entries when a consumer edits its projection", () => {
    const ledger = createUnifiedAgentRunLedger();
    const admitted = ledger.submit(admission({ scene: "side_chat" }));
    admitted.entry.target.id = "consumer-local-change";
    admitted.entry.ownerFence.ownerToken = "consumer-local-owner";

    expect(ledger.get(admitted.entry.runId)).toMatchObject({
      target: { id: "conversation-1" },
      ownerFence: { ownerToken: expect.not.stringMatching("consumer-local-owner") },
    });
  });
});
