import {
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
  type Db,
} from "@rudderhq/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitClaudeDeferredFork,
  assertClaudeDeferredForkReplaySafety,
  classifyClaudeDeferredForkRecovery,
  ClaudeDeferredForkRecoveryIdentityError,
} from "./claude-deferred-fork-admission.js";
import type { NativeForkIntentRunFence } from "./runtime-kernel/native-fork-intent.js";
import type { SideChatForkSource } from "./side-chat-runtime-admission.js";

const verifyClaudeHead = vi.hoisted(() => vi.fn());

vi.mock("@rudderhq/agent-runtime-claude-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rudderhq/agent-runtime-claude-local/server")>();
  return { ...actual, verifyClaudeSessionAssistantHead: verifyClaudeHead };
});

const source: SideChatForkSource = {
  sourceConversationId: "source-conversation",
  sourceMessageId: "source-message",
  sourceRunId: "source-run",
  sourceSpanId: "source-span",
  sourceBoundaryRef: "selected-assistant",
  selectorJson: {
    kind: "claude_chain",
    sessionId: "parent-session",
    startExclusiveUuid: null,
    throughInclusiveUuid: "selected-assistant",
  },
  session: {
    sessionId: "parent-session",
    sessionParams: { sessionId: "parent-session" },
    sessionDisplayId: "parent-session",
  },
  sourceBinding: {
    id: "source-binding",
    orgId: "test-org",
    runtimeType: "claude_local",
    principalScopeRef: "user:test",
    hostId: "local",
    profileId: "default",
    workspaceBindingId: null,
    capabilityRevision: "capability-1",
  },
};

const common = {
  db: null as unknown as Db,
  sourceBindingMatchesTarget: true,
  bindingInput: {
    orgId: "test-org",
    conversationId: "child-conversation",
    agentId: "test-agent",
    runtimeType: "claude_local",
    principalScopeRef: "user:test",
    hostId: "local",
    profileId: "default",
    workspaceBindingId: null,
    capabilityRevision: "capability-1",
  },
  providerBinding: { orgId: "test-org", hostId: "local", profileId: "default" },
  config: { cwd: "/tmp/workspace", claudeConfigDir: "/tmp/claude", providerVersion: "2.1.216" },
  conversationId: "child-conversation",
};

describe("Claude deferred Side Chat admission", () => {
  beforeEach(() => verifyClaudeHead.mockReset());

  it("does not reserve a fork when the selected Span and assistant UUID disagree", async () => {
    const result = await admitClaudeDeferredFork({
      ...common,
      source: { ...source, sourceBoundaryRef: "another-assistant" },
    });
    expect(result).toMatchObject({
      admission: {
        continuity: "context_handoff",
        downgradeReason: "claude_exact_source_boundary_unavailable",
        sessionIntent: { kind: "fresh" },
      },
      adapterIntent: null,
      reference: null,
    });
  });

  it("does not infer native fork support from an unverified provider version", async () => {
    const result = await admitClaudeDeferredFork({
      ...common,
      source,
      config: { ...common.config, providerVersion: "2.1.217" },
    });
    expect(result.admission).toMatchObject({
      continuity: "context_handoff",
      downgradeReason: "claude_fork_profile_not_verified",
    });
    expect(result.adapterIntent).toBeNull();
  });

  it("does not admit a fork without a durable source binding ID", async () => {
    const result = await admitClaudeDeferredFork({
      ...common,
      source: { ...source, sourceBinding: { ...source.sourceBinding!, id: undefined } },
    });
    expect(result.admission.continuity).toBe("context_handoff");
    expect(result.adapterIntent).toBeNull();
  });

  it.each(["initial", "bounded", "exact"])(
    "routes a sealed historical %s selector through the exact native fork path",
    async (boundaryStatus) => {
      verifyClaudeHead.mockResolvedValueOnce({
        status: "mismatch",
        sourceAssistantUuid: "selected-assistant",
        currentAssistantUuid: "later-assistant",
        revision: "verified-provider-file-revision",
        reason: "Claude session head advanced to a later assistant",
      });

      const result = await admitClaudeDeferredFork({
        ...common,
        source: {
          ...source,
          selectorJson: { ...source.selectorJson!, boundaryStatus },
        },
      });

      expect(result.useExactNativeFork).toBe(true);
      expect(result.adapterIntent).toBeNull();
      expect(result.reservation).toBeNull();
      expect(verifyClaudeHead).toHaveBeenCalledWith(expect.objectContaining({
        sourceAssistantUuid: "selected-assistant",
      }));
    },
  );

  it.each([undefined, "unknown", "partial", "missing"])(
    "keeps a historical selector with boundary status %s on the safe handoff path",
    async (boundaryStatus) => {
      verifyClaudeHead.mockResolvedValueOnce({
        status: "mismatch",
        sourceAssistantUuid: "selected-assistant",
        currentAssistantUuid: "later-assistant",
        revision: "verified-provider-file-revision",
        reason: "Claude session head advanced to a later assistant",
      });
      const selectorJson = {
        ...source.selectorJson!,
        ...(boundaryStatus ? { boundaryStatus } : {}),
      };

      const result = await admitClaudeDeferredFork({
        ...common,
        source: { ...source, selectorJson },
      });

      expect(result.useExactNativeFork).not.toBe(true);
      expect(result.admission).toMatchObject({
        continuity: "context_handoff",
      });
      expect(result.admission.downgradeReason).toBe(boundaryStatus === "missing"
        ? "claude_exact_source_boundary_unavailable"
        : "claude_selected_reply_is_not_provider_head");
    },
  );

  it("does not route a historical selector whose otherwise exact metadata is incomplete", async () => {
    verifyClaudeHead.mockResolvedValueOnce({
      status: "mismatch",
      sourceAssistantUuid: "selected-assistant",
      currentAssistantUuid: "later-assistant",
      revision: "verified-provider-file-revision",
      reason: "Claude session head advanced to a later assistant",
    });

    const result = await admitClaudeDeferredFork({
      ...common,
      source: {
        ...source,
        selectorJson: { ...source.selectorJson!, boundaryStatus: "exact", completeness: "partial" },
      },
    });

    expect(result.useExactNativeFork).not.toBe(true);
    expect(result.admission.downgradeReason).toBe("claude_selected_reply_is_not_provider_head");
  });

  it.each([
    { currentAssistantUuid: null, revision: "verified-provider-file-revision" },
    { currentAssistantUuid: "later-assistant", revision: null },
  ])("requires both a verifiable current head and file revision before routing history (%o)", async (proof) => {
    verifyClaudeHead.mockResolvedValueOnce({
      status: "mismatch",
      sourceAssistantUuid: "selected-assistant",
      ...proof,
      reason: "Claude source head cannot be fully verified",
    });

    const result = await admitClaudeDeferredFork({
      ...common,
      source: {
        ...source,
        selectorJson: { ...source.selectorJson!, boundaryStatus: "initial" },
      },
    });

    expect(result.useExactNativeFork).not.toBe(true);
    expect(result.admission).toMatchObject({
      continuity: "context_handoff",
      downgradeReason: "claude_source_head_cannot_be_verified",
    });
  });
});

describe("Claude deferred fork recovery", () => {
  const intent = {
    version: 1, intentId: "intent-1", idempotencyKey: "side-chat:child",
    status: "reserved", source: {
      orgId: "test-org", sourceRunId: "source-run", sourceSpanId: "source-span",
      sourceBoundaryRef: "assistant-1", selectorJson: { kind: "claude_chain" },
    },
    target: {
      bindingId: "child-binding", segmentId: "child-segment", orgId: "test-org", bindingEpoch: 0,
      runtimeType: "claude_local", hostId: "local", profileId: "default",
      workspaceBindingId: null, capabilityRevision: "capability-1",
    },
    reason: null, reconciliation: "not_required", reconciliationNote: null,
    createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
  };
  const providerState = (status: string) => ({
    __rudderNativeForkIntent: {
      ...intent, status,
      ...(status === "accepted" ? { child: {
        session: { sessionId: "child-session", sessionParams: {}, sessionDisplayId: "child-session" },
        boundary: "assistant-2", continuity: "native",
      } } : {}),
    },
  });

  it.each(["reserved", "unknown", "rejected"])("blocks a later input after %s", (status) => {
    expect(() => assertClaudeDeferredForkReplaySafety({
      providerState: providerState(status), firstSend: false, recoveringRun: false,
    })).toThrow(/reconciliation is required/);
  });

  it("allows a later input after a durably accepted child, but not replay of the same Run", () => {
    expect(() => assertClaudeDeferredForkReplaySafety({
      providerState: providerState("accepted"), firstSend: false, recoveringRun: false,
    })).not.toThrow();
    expect(() => assertClaudeDeferredForkReplaySafety({
      providerState: providerState("accepted"), firstSend: false, recoveringRun: true,
    })).toThrow(/reconciliation is required/);
  });

  it("blocks recovery when admission never produced an intent", () => {
    expect(() => assertClaudeDeferredForkReplaySafety({
      providerState: null, firstSend: false, recoveringRun: true,
    })).toThrow(/no durable result/);
  });

  const selector = {
    kind: "claude_chain",
    sessionId: "source-session",
    startExclusiveUuid: null,
    throughInclusiveUuid: "assistant-1",
  };
  const descriptor = {
    version: 1 as const,
    kind: "claude_fork_on_first_input" as const,
    sourceBindingId: "source-binding",
    sourceSession: {
      sessionId: "source-session",
      sessionDisplayId: "source-session",
      sessionParams: { sessionId: "source-session" },
    },
    sourceSelector: {
      kind: "claude_chain" as const,
      sessionId: "source-session",
      throughInclusiveUuid: "assistant-1",
    },
  };
  const currentFence: NativeForkIntentRunFence = {
    runId: "child-run",
    spanId: "child-span",
    ownerToken: "owner-current",
    attemptEpoch: 3,
  };
  const intentRecord = (status: string, overrides: Record<string, unknown> = {}) => ({
    version: 1,
    intentId: "intent-1",
    idempotencyKey: "side-chat:child-conversation",
    status,
    source: {
      orgId: "test-org",
      sourceConversationId: "source-conversation",
      sourceRunId: "source-run",
      sourceSpanId: "source-span",
      sourceBoundaryRef: "assistant-1",
      selectorJson: selector,
    },
    target: {
      bindingId: "child-binding",
      segmentId: "child-segment",
      orgId: "test-org",
      bindingEpoch: 0,
      runtimeType: "claude_local",
      hostId: "local",
      profileId: "default",
      workspaceBindingId: null,
      capabilityRevision: "capability-1",
    },
    runFence: currentFence,
    ...(status === "accepted" ? { child: {
      session: { sessionId: "child-session", sessionParams: {}, sessionDisplayId: "child-session" },
      boundary: "assistant-2",
      sourceBoundary: "assistant-1",
      continuity: "native",
    } } : {}),
    reason: null,
    reconciliation: "not_required",
    reconciliationNote: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  });

  function recoveryDb(input: {
    targetIntent?: Record<string, unknown> | null;
    targetSegment?: Record<string, unknown>;
    targetSpan?: Record<string, unknown>;
    context?: Record<string, unknown>;
  } = {}) {
    const sideChatRuntimeAdmission = {
      continuity: "native",
      sourceConversationId: "source-conversation",
      sourceRunId: "source-run",
      sourceSpanId: "source-span",
      sourceBoundaryRef: "assistant-1",
      sourceSelectorJson: selector,
      deferredForkDescriptor: descriptor,
    };
    const run = {
      id: "child-run",
      orgId: "test-org",
      agentId: "child-agent",
      chatConversationId: "child-conversation",
      status: "running",
      scene: "side_chat",
      targetType: "chat_conversation",
      targetId: "child-conversation",
      executionOwnerToken: currentFence.ownerToken,
      executionLeaseExpiresAt: new Date(Date.now() + 60_000),
      contextSnapshot: {
        scene: "side_chat",
        targetType: "chat_conversation",
        targetId: "child-conversation",
        conversationId: "child-conversation",
        runtimeBindingId: "child-binding",
        runtimeSegmentId: "child-segment",
        sourceRunId: "source-run",
        sourceSpanId: "source-span",
        sourceSelectorJson: selector,
        sideChatRuntimeAdmission,
        ...input.context,
      },
    };
    const binding = {
      id: "child-binding",
      orgId: "test-org",
      conversationId: "child-conversation",
      currentSegmentId: "child-segment",
      status: "active",
      continuity: "native",
      runtimeType: "claude_local",
      bindingEpoch: 0,
      hostId: "local",
      profileId: "default",
      workspaceBindingId: null,
      capabilityRevision: "capability-1",
    };
    const targetSegment = {
      id: "child-segment",
      orgId: "test-org",
      bindingId: "child-binding",
      runtimeType: "claude_local",
      nativeSessionId: null,
      providerStateJson: input.targetIntent ? { __rudderNativeForkIntent: input.targetIntent } : null,
      state: "pending",
      ...input.targetSegment,
    };
    const targetSpan = {
      id: currentFence.spanId,
      runId: currentFence.runId,
      orgId: "test-org",
      bindingId: "child-binding",
      segmentId: "child-segment",
      ownerToken: currentFence.ownerToken,
      attemptEpoch: currentFence.attemptEpoch,
      relation: "primary",
      nativeExecutionRef: null,
      state: "open",
      ...input.targetSpan,
    };
    const sourceRun = {
      id: "source-run",
      orgId: "test-org",
      agentId: "source-agent",
      chatConversationId: "source-conversation",
      status: "succeeded",
      sessionIdAfter: "source-session",
      contextSnapshot: { runtimeProviderProfile: { runtimeType: "claude_local" } },
    };
    const sourceSpan = {
      id: "source-span",
      orgId: "test-org",
      runId: "source-run",
      bindingId: "source-binding",
      segmentId: "source-segment",
      nativeExecutionRef: "assistant-1",
      selectorJson: selector,
      state: "sealed",
      completeness: "complete",
    };
    const sourceSegment = {
      id: "source-segment",
      orgId: "test-org",
      bindingId: "source-binding",
      runtimeType: "claude_local",
      nativeSessionId: "source-session",
      leafId: "assistant-1",
      sourceBoundaryRef: null,
    };
    const sourceBinding = {
      id: "source-binding",
      orgId: "test-org",
      conversationId: "source-conversation",
      agentId: "source-agent",
      runtimeType: "claude_local",
    };
    const queues = new Map<unknown, unknown[][]>([
      [heartbeatRuns, [[run], [sourceRun]]],
      [runtimeBindings, [[binding], [sourceBinding]]],
      [nativeSegments, [[targetSegment], [sourceSegment]]],
      [runRuntimeSpans, [[targetSpan], [sourceSpan]]],
    ]);
    let writeCount = 0;
    const db = {
      select: () => ({
        from: (table: unknown) => {
          const rows = queues.get(table)?.shift() ?? [];
          const query = {
            where: () => query,
            limit: async () => rows,
            then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
          return query;
        },
      }),
      insert: () => { writeCount += 1; },
      update: () => { writeCount += 1; },
      delete: () => { writeCount += 1; },
      execute: () => { writeCount += 1; },
    } as unknown as Db;
    return { db, getWriteCount: () => writeCount };
  }

  const classify = (db: Db, runFence = currentFence) => classifyClaudeDeferredForkRecovery({
    db,
    orgId: "test-org",
    conversationId: "child-conversation",
    runId: "child-run",
    bindingId: "child-binding",
    segmentId: "child-segment",
    runFence,
  });

  it("classifies a pristine descriptor-only recovery without writing and returns the exact reservation key", async () => {
    const { db, getWriteCount } = recoveryDb();

    const result = await classify(db);

    expect(result).toMatchObject({
      status: "descriptor_only",
      idempotencyKey: "side-chat:child-conversation",
      runFence: currentFence,
    });
    expect("replayAllowed" in result).toBe(false);
    expect(getWriteCount()).toBe(0);
  });

  it.each(["reserved", "unknown", "rejected"] as const)("classifies a durable %s intent", async (status) => {
    const { db, getWriteCount } = recoveryDb({ targetIntent: intentRecord(status) });

    const result = await classify(db);

    expect(result).toMatchObject({
      status,
      idempotencyKey: "side-chat:child-conversation",
      runFence: currentFence,
    });
    expect("replayAllowed" in result).toBe(false);
    expect(getWriteCount()).toBe(0);
  });

  it("classifies an accepted child only when its session and boundary are bound to the open Span", async () => {
    const { db, getWriteCount } = recoveryDb({
      targetIntent: intentRecord("accepted"),
      targetSegment: { state: "open", nativeSessionId: "child-session" },
      targetSpan: { nativeExecutionRef: "assistant-2" },
    });

    const result = await classify(db);

    expect(result).toMatchObject({
      status: "accepted_child_open_span",
      idempotencyKey: "side-chat:child-conversation",
      replayAllowed: false,
      child: { session: { sessionId: "child-session" }, boundary: "assistant-2" },
    });
    expect(getWriteCount()).toBe(0);
  });

  it.each([
    ["runId", "another-run"],
    ["spanId", "another-span"],
    ["ownerToken", "stale-owner"],
    ["attemptEpoch", 2],
  ] as const)("rejects a caller fence with mismatched %s", async (field, value) => {
    const { db } = recoveryDb();
    const staleFence = { ...currentFence, [field]: value } as NativeForkIntentRunFence;

    await expect(classify(db, staleFence)).rejects.toBeInstanceOf(ClaudeDeferredForkRecoveryIdentityError);
  });

  it.each([
    ["open", null, null],
    ["pending", "unexpected-session", null],
    ["pending", null, { sessionId: "unexpected-provider-state" }],
  ] as const)("rejects descriptor-only recovery for non-pristine segment state", async (state, nativeSessionId, providerStateJson) => {
    const { db } = recoveryDb({ targetSegment: { state, nativeSessionId, providerStateJson } });

    await expect(classify(db)).rejects.toBeInstanceOf(ClaudeDeferredForkRecoveryIdentityError);
  });

  it("accepts an empty provider-state object as pristine for descriptor-only recovery", async () => {
    const { db } = recoveryDb({ targetSegment: { providerStateJson: {} } });

    await expect(classify(db)).resolves.toMatchObject({ status: "descriptor_only" });
  });

  it("rejects a persisted intent with a noncanonical idempotency key", async () => {
    const wrongKey = intentRecord("reserved", { idempotencyKey: "side-chat:another-conversation" });
    const { db } = recoveryDb({ targetIntent: wrongKey });

    await expect(classify(db)).rejects.toBeInstanceOf(ClaudeDeferredForkRecoveryIdentityError);
  });

  it("rejects source identity, selector, and target identity mismatches", async () => {
    const mismatchedSourceIdentity = intentRecord("reserved", {
      source: { ...intentRecord("reserved").source, sourceSpanId: "another-source-span" },
    });
    const mismatchedSourceDb = recoveryDb({ targetIntent: mismatchedSourceIdentity });
    await expect(classify(mismatchedSourceDb.db)).rejects.toBeInstanceOf(ClaudeDeferredForkRecoveryIdentityError);

    const mismatchedSelectorDb = recoveryDb({
      context: {
        sourceSelectorJson: { ...selector, throughInclusiveUuid: "another-assistant" },
      },
    });
    await expect(classify(mismatchedSelectorDb.db)).rejects.toBeInstanceOf(ClaudeDeferredForkRecoveryIdentityError);

    const mismatchedTarget = intentRecord("reserved", {
      target: { ...intentRecord("reserved").target, segmentId: "another-segment" },
    });
    const mismatchedTargetDb = recoveryDb({ targetIntent: mismatchedTarget });
    await expect(classify(mismatchedTargetDb.db)).rejects.toBeInstanceOf(ClaudeDeferredForkRecoveryIdentityError);
  });
});
