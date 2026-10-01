import type { AgentRuntimeExecutionResult, ModelAttemptSpec } from "@rudderhq/agent-runtime-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Wiring regression, not provider/DB acceptance. Keep production Chat, owner,
// and native-attempt callbacks; inject executor results and persistence faults.
const fixture = vi.hoisted(() => {
  const binding = { id: "binding", orgId: "org", conversationId: "side", runtimeType: "claude_local",
    continuity: "native", bindingEpoch: 0, currentSegmentId: "segment" };
  const segment = { id: "segment", providerStateJson: null };
  const session = { sessionId: null, sessionParams: null, sessionDisplayId: null, segment };
  const run = { id: "run", orgId: "org", agentId: "agent", runtimeSpanId: "span",
    runtimeSpanOwnerToken: "owner", runtimeSpanAttemptEpoch: 1,
    runtimeAttemptRef: { id: "attempt", attemptIndex: 0 } };
  const admission = { continuity: "native", sourceConversationId: "main", sourceMessageId: "anchor",
    sourceRunId: "parent-run", sourceSpanId: "parent-span", sourceBoundaryRef: "parent-assistant",
    sessionIntent: { kind: "fresh" }, providerCapability: null, downgradeReason: null };
  return { binding, session, run, admission, events: [] as string[], sealed: false,
    controller: new AbortController(), loseOwner: false,
    reference: { bindingId: "binding", segmentId: "segment", intentId: "intent" },
    observer: vi.fn(), abort: vi.fn(), finalize: vi.fn(), transfer: vi.fn(),
    terminalOutcome: vi.fn(), release: vi.fn(), dispatch: vi.fn() };
});

vi.mock("./chat-assistant.runtime-resolution.js", () => ({
  createChatAssistantAvailability: () => ({}),
  isAgentRuntimeType: () => true,
  createChatAssistantRuntimeResolution: () => ({
    resolveChatInvocation: async () => ({
      runtimeSource: { agentRuntimeType: "claude_local", descriptor: { runtimeAgentId: "agent" }, runtimeSkills: [] },
      adapter: { type: "claude_local" },
      config: { model: "primary", cwd: "/tmp", modelFallbacks: [{ model: "backup" }] },
      linkedIssueIds: [], linkedProjectId: null, linkedGoalId: null,
      sceneContext: { rudderWorkspace: {}, rudderScene: {} },
    }),
  }),
}));
vi.mock("../agent-runtimes/prepare-runtime-provider-profile.js", () => ({
  prepareRuntimeProviderProfile: async ({ config }: { config: unknown }) => config,
}));
vi.mock("../agent-runtimes/index.js", () => ({
  getRuntimeDriver: () => ({ capabilities: {} }), findServerAdapter: vi.fn(),
  createProfileBoundRuntimeProviderCapabilityResolverFromConfig: () => () => null,
}));
vi.mock("./chat-assistant.side-chat-source.js", () => ({
  loadSideChatForkSource: async () => ({ sourceBinding: fixture.binding, sourceRunId: "parent-run",
    sourceSpanId: "parent-span", sourceBoundaryRef: "parent-assistant", selectorJson: { kind: "claude_chain" } }),
  sideChatForkBindingMatchesTarget: () => true,
  deriveSideChatForkSourceForCurrentProfile: (source: unknown) => source,
  deriveSideChatContextHandoff: () => null,
  resolveChatContinuationSession: async () => ({ initialSession: fixture.session,
    continuationTransport: {}, runtimeExecutionConfig: { model: "primary", cwd: "/tmp" } }),
  chatSessionForCurrentProviderProfile: (_type: unknown, session: unknown) => session,
}));
vi.mock("./claude-deferred-fork-admission.js", () => ({
  admitClaudeDeferredFork: async () => ({ admission: fixture.admission,
    adapterIntent: { version: 1 }, reservation: { idempotencyKey: "side-chat:side" } }),
  reserveClaudeDeferredFork: async () => { fixture.events.push("reserved"); return fixture.reference; },
  recordClaudeDeferredForkOutcome: fixture.terminalOutcome,
}));
vi.mock("./chat-assistant.claude-fork-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-assistant.claude-fork-recovery.js")>();
  return { ...actual, assertClaudeSideChatInputSafe: async () => {} };
});
vi.mock("./runtime-kernel/native-fork-intent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-kernel/native-fork-intent.js")>();
  return { ...actual, abortReservedNativeForkIntentRunFence: fixture.abort,
    transferReservedNativeForkIntentRunFence: fixture.transfer };
});
vi.mock("./runtime-kernel/native-session.js", () => ({ revisionForRuntimeConfig: () => "revision" }));
vi.mock("./approvals.js", () => ({ approvalService: () => ({}) }));
vi.mock("./runtime-kernel/runtime-approval.js", () => ({ createRuntimeApprovalBridge: () => ({}) }));
vi.mock("./managed-workspace-preflight.js", () => ({ preflightManagedAgentWorkspace: async () => {} }));
vi.mock("./chat-assistant.runtime-prompt.js", () => ({
  buildChatAssistantRuntimePrompt: async () => ({ prompt: "current input", context: {} }),
}));
vi.mock("./chat-assistant.native-transcript.js", () => ({ resolveChatTranscriptCapability: () => null }));
vi.mock("./chat-assistant.runtime-driver.js", () => ({
  chatAttemptFailureFinishInput: vi.fn(),
  createChatAssistantRuntimeDriverPorts: () => ({
    factoryOptions: () => ({}), isNativeRuntime: () => true,
    ensureSession: async () => ({ binding: fixture.binding, nativeSession: fixture.session }),
    createAttemptPorts: () => ({ onAttemptResult: fixture.observer, resolveDriver: vi.fn(), onAttemptFailure: vi.fn() }),
  }),
}));
vi.mock("./chat-agent-runs.js", () => ({ chatAgentRunService: () => ({
  createRun: async () => fixture.run,
  beginOwnedRunExecution: () => ({ signal: fixture.controller.signal, release: fixture.release }),
  beginRuntimeAttempt: async () => fixture.run.runtimeAttemptRef,
  recordNativeExecutionResult: async () => {
    fixture.sealed = true;
    fixture.events.push("span_sealed");
    return { id: "span", attemptRef: fixture.run.runtimeAttemptRef };
  },
  finalizeRun: fixture.finalize,
}) }));
vi.mock("./runtime-kernel/model-fallback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-kernel/model-fallback.js")>();
  return { ...actual, executeAdapterWithModelFallbacks: async (
    _adapter: unknown, _context: unknown, options: Parameters<typeof actual.executeAdapterWithModelFallbacks>[2],
  ) => {
    const attempt: ModelAttemptSpec = { index: 0, agentRuntimeType: "claude_local", model: "primary",
      config: null, isFallback: false, fallbackIndex: null, totalFallbacks: 1 };
    const failure: AgentRuntimeExecutionResult = { exitCode: 1, signal: null, timedOut: false,
      submissionPhase: "pre_submission", nativeWriterQuiescence: { status: "confirmed", source: "not_started" } };
    await options!.onAttemptStart!(attempt, { type: "claude_local" } as any);
    // Fault injection at the lifecycle boundary: no driver input was dispatched,
    // and an eligible next attempt exists, but the reconciliation observer fails.
    await options!.onAttemptResult!(attempt, failure, "pre_submission", { providerDispatched: false, willFallback: true });
    fixture.dispatch(); // Must be unreachable; this is not a real provider call.
    throw new Error("observer unexpectedly returned");
  } };
});

const { chatAssistantService } = await import("./chat-assistant.js");
const db = { select: () => ({ from: () => ({ where: () => ({
  orderBy: () => ({ limit: async () => [] }),
}) }) }) };

describe("production Chat dependent finalization hookup (mocked persistence)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.events.length = 0;
    fixture.sealed = false;
    fixture.loseOwner = false;
    fixture.controller = new AbortController();
    fixture.observer.mockImplementation(async () => {
      expect(fixture.sealed).toBe(true);
      fixture.events.push("observer_throw");
      if (fixture.loseOwner) fixture.controller.abort();
      throw new Error("sealed-span reconciliation observer failed");
    });
    fixture.abort.mockImplementation(async (_db, input) => {
      expect(fixture.sealed).toBe(true);
      expect(input.reference).toBe(fixture.reference);
      expect(input.runFence).toEqual({ runId: "run", spanId: "span", ownerToken: "owner", attemptEpoch: 1 });
      fixture.events.push("intent_unknown");
    });
    fixture.finalize.mockImplementation(async () => { fixture.events.push("run_finalized"); });
  });

  const execute = () => chatAssistantService(db as any).streamChatAssistantReply({
    conversation: { id: "side", orgId: "org", conversationKind: "side_chat", planMode: false },
    messages: [{ id: "message", role: "user", body: "current input", attachments: [] }],
    userMessageId: "message", contextLinks: [], stream: true,
  } as any);

  it("aborts the reserved old fence after span sealing and before production Run finalization", async () => {
    const abort = fixture.abort.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const pendingAbort = new Promise<void>((resolve) => { release = resolve; });
    const abortStarted = new Promise<void>((resolve) => { entered = resolve; });
    fixture.abort.mockImplementation(async (...args) => {
      await abort(...args);
      entered();
      await pendingAbort;
    });
    const outcome = expect(execute()).rejects.toThrow("sealed-span reconciliation observer failed");
    await abortStarted;
    try {
      expect(fixture.finalize).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await outcome;
    expect(fixture.events).toEqual(["reserved", "span_sealed", "observer_throw", "intent_unknown", "run_finalized"]);
    expect(fixture.abort).toHaveBeenCalledOnce();
    expect(fixture.finalize).toHaveBeenCalledOnce();
    expect(fixture.finalize).toHaveBeenCalledWith("run", expect.objectContaining({ status: "failed" }));
    expect(fixture.transfer).not.toHaveBeenCalled();
    expect(fixture.terminalOutcome).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("does not release the Run through finalization when the dependent abort CAS rejects", async () => {
    fixture.abort.mockRejectedValue(new Error("dependent abort CAS rejected"));
    await expect(execute()).rejects.toThrow("dependent abort CAS rejected");
    expect(fixture.abort).toHaveBeenCalled();
    expect(fixture.finalize).not.toHaveBeenCalled();
    expect(fixture.transfer).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("returns stale without dependent mutation when the observer loses the owner", async () => {
    fixture.loseOwner = true;
    await expect(execute()).resolves.toEqual({ outcome: "stale", reason: "execution_owner_lost" });
    expect(fixture.abort).not.toHaveBeenCalled();
    expect(fixture.finalize).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});
