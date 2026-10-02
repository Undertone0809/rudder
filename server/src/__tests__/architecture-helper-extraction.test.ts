import { describe, expect, it, vi } from "vitest";
import { respondToChatPreGenerationPersistenceFailure } from "../routes/chats.stream-pre-generation-failure.js";
import { boundedText, normalizeSourceSpanInput, stableJson } from "../services/chat-agent-runs.helpers.js";
import { cleanupHeartbeatExecution } from "../services/runtime-kernel/heartbeat.execution-cleanup.js";

describe("mechanical architecture helper extraction", () => {
  it("keeps source-span normalization fail-closed and clones selectors", () => {
    expect(normalizeSourceSpanInput({})).toBeNull();
    expect(() => normalizeSourceSpanInput({ sourceRunId: "run" })).toThrow("requires sourceRunId");
    expect(() => normalizeSourceSpanInput({ sourceRunId: "run", sourceSpanId: "span", sourceSelectorJson: { kind: "pending" } })).toThrow("completed native boundary");
    const selector = { kind: "codex_turn", turnId: "turn" };
    const result = normalizeSourceSpanInput({ sourceRunId: " run ", sourceSpanId: " span ", sourceSelectorJson: selector });
    expect(result).toEqual({ sourceRunId: "run", sourceSpanId: "span", sourceSelectorJson: selector });
    expect(result?.sourceSelectorJson).not.toBe(selector);
  });

  it("keeps bounded event text and nested stable selector comparison", () => {
    expect(boundedText("")).toBeNull();
    expect(boundedText("abcd", 2)).toBe("ab...");
    expect(stableJson({ z: [{ b: 2, a: 1 }], a: null })).toBe(stableJson({ a: null, z: [{ a: 1, b: 2 }] }));
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });

  function cleanupFixture(overrides: Record<string, unknown> = {}) {
    const order: string[] = [];
    const input = {
      run: { id: "run", agentId: "agent" }, executionLeaseTimer: null,
      commonSpanId: "span", runWasRunningAtEntry: false, providerDispatchStarted: false,
      acknowledgeRunProcessExit: vi.fn(async () => { order.push("ack"); }),
      releaseRuntimeServicesForRun: vi.fn(async () => { order.push("release"); }),
      runAbortControllers: { delete: vi.fn(() => { order.push("forget-controller"); }) },
      activeRunExecutions: { delete: vi.fn(() => { order.push("forget-execution"); }) },
      networkSuspended: false,
      startNextQueuedRunForAgent: vi.fn(async () => { order.push("queue"); }),
      ...overrides,
    };
    return { input, order };
  }

  it("awaits pre-dispatch acknowledgment before release and queue", async () => {
    const { input, order } = cleanupFixture();
    let resolve!: () => void;
    input.acknowledgeRunProcessExit.mockImplementationOnce(async () => {
      order.push("ack-start");
      await new Promise<void>((done) => { resolve = done; });
      order.push("ack-end");
    });
    const pending = cleanupHeartbeatExecution(input);
    await Promise.resolve();
    expect(order).toEqual(["ack-start"]);
    resolve();
    await pending;
    expect(order).toEqual(["ack-start", "ack-end", "release", "forget-controller", "forget-execution", "queue"]);
    expect(input.acknowledgeRunProcessExit).toHaveBeenCalledWith("run", expect.objectContaining({
      submissionPhase: "pre_submission", nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
    }), "span");
  });

  it.each([
    { providerDispatchStarted: true }, { runWasRunningAtEntry: true }, { commonSpanId: null },
  ])("does not claim unknown native writer quiescence: %j", async (overrides) => {
    const { input, order } = cleanupFixture(overrides);
    await cleanupHeartbeatExecution(input);
    expect(input.acknowledgeRunProcessExit).not.toHaveBeenCalled();
    expect(order).toEqual(["release", "forget-controller", "forget-execution", "queue"]);
  });

  it("still forgets ownership after release failure and preserves suspended queue", async () => {
    const { input, order } = cleanupFixture({ networkSuspended: true });
    input.releaseRuntimeServicesForRun.mockImplementationOnce(async () => { order.push("release"); throw Error("release failure"); });
    await cleanupHeartbeatExecution(input);
    expect(order).toEqual(["ack", "release", "forget-controller", "forget-execution"]);
    expect(input.startNextQueuedRunForAgent).not.toHaveBeenCalled();
  });

  function failureFixture() {
    const order: string[] = [], events: unknown[] = [];
    const user = { id: "user-message", orgId: "org", conversationId: "chat", role: "user", kind: "message", status: "completed", body: "saved input", chatTurnId: "turn", turnVariant: 1, supersededAt: null };
    const input: Parameters<typeof respondToChatPreGenerationPersistenceFailure>[0] = {
      conversation: { id: "chat", orgId: "org", preferredAgentId: "agent" } as any,
      actor: { actorType: "user", actorId: "operator" } as any,
      sideChatFirstInputClaimToken: "claim",
      sideChats: { releaseFirstInputClaim: vi.fn(async () => { order.push("release-claim"); }) },
      messagePersistence: { kind: "error", messageId: user.id, error: Error("hydrate failed") },
      clientMutationId: "mutation", clientMutationFingerprint: "fingerprint", parsedBody: { data: { body: user.body } },
      svc: {
        getMessage: vi.fn(async () => { order.push("get-user"); return user; }),
        getUserMessageMutationByClientMutationId: vi.fn(async () => { order.push("get-mutation"); return { message: user, fingerprint: "fingerprint" }; }),
        listMessages: vi.fn(async () => { order.push("list"); return [user]; }),
        addMessage: vi.fn(async (_id, payload) => { order.push("add-failure"); return { id: "failed-assistant", ...payload }; }),
      },
      logChatMessagesAdded: vi.fn(async () => { order.push("log"); }),
      releaseGeneration: vi.fn(() => { order.push("release-generation"); }),
      res: { status: vi.fn(() => { order.push("status"); }), setHeader: vi.fn(), end: vi.fn(() => { order.push("end"); }) } as any,
      writeStreamEvent: vi.fn((_res, event) => { events.push(event); order.push((event as any).type); }),
    };
    return { input, order, events, user };
  }

  it("persists failure and logs before release/ack/error/end without starting generation", async () => {
    const { input, order, events, user } = failureFixture();
    await respondToChatPreGenerationPersistenceFailure(input);
    expect(order).toEqual(["release-claim", "get-user", "get-mutation", "list", "add-failure", "log", "release-generation", "status", "ack", "error", "end"]);
    expect(events).toMatchObject([{ type: "ack", userMessage: user }, { type: "error", messageId: "failed-assistant" }]);
    expect(input.svc.addMessage).toHaveBeenCalledWith("chat", expect.objectContaining({
      runId: null, chatTurnId: "turn", turnVariant: 1, structuredPayload: { recoverableFailure: expect.objectContaining({
        code: "chat_input_persisted_reply_not_started", dispatchEvidence: expect.objectContaining({ originalDispatch: "not_started", orgId: "org", conversationId: "chat", userMessageId: user.id }),
      }) },
    }));
  });

  it.each(["org", "fingerprint", "variants"])("rejects unproven saved input (%s) without granting retry", async (drift) => {
    const { input, events, user } = failureFixture();
    if (drift === "org") input.svc.getMessage.mockResolvedValueOnce({ ...user, orgId: "other" });
    if (drift === "fingerprint") input.svc.getUserMessageMutationByClientMutationId.mockResolvedValueOnce({ message: user, fingerprint: "wrong" });
    if (drift === "variants") input.svc.listMessages.mockResolvedValueOnce([user, { ...user, id: "duplicate" }]);
    await respondToChatPreGenerationPersistenceFailure(input);
    expect(input.svc.addMessage).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", messageId: user.id });
  });

  it("retains verified ack if failure-row persistence fails", async () => {
    const { input, events, user } = failureFixture();
    input.svc.addMessage.mockRejectedValueOnce(Error("write failed"));
    await respondToChatPreGenerationPersistenceFailure(input);
    expect(input.releaseGeneration).toHaveBeenCalledOnce();
    expect(events).toMatchObject([{ type: "ack", userMessage: user }, { type: "error", messageId: user.id }]);
    expect(input.res.end).toHaveBeenCalledOnce();
  });
});
