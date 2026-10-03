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
    controller: new AbortController(), loseOwner: false, runtimeType: "claude_local",
    stop: null as AbortController | null, stopResult: null as AgentRuntimeExecutionResult | null,
    repeatResult: null as AgentRuntimeExecutionResult | null,
    rejectRecording: false, mismatchRecording: false, loseOwnerDuringRecord: false,
    recordGate: null as (() => Promise<void>) | null,
    observedRecording: vi.fn(),
    reference: { bindingId: "binding", segmentId: "segment", intentId: "intent" },
    observer: vi.fn(), abort: vi.fn(), finalize: vi.fn(), transfer: vi.fn(),
    terminalOutcome: vi.fn(), release: vi.fn(), dispatch: vi.fn() };
});

vi.mock("./chat-assistant.runtime-resolution.js", () => ({
  createChatAssistantAvailability: () => ({}),
  isAgentRuntimeType: () => true,
  createChatAssistantRuntimeResolution: () => ({
    resolveChatInvocation: async () => ({
      runtimeSource: { agentRuntimeType: fixture.runtimeType, descriptor: { runtimeAgentId: "agent" }, runtimeSkills: [] },
      adapter: { type: fixture.runtimeType },
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
  recordNativeExecutionResult: async (runId: string, result: AgentRuntimeExecutionResult, fence: unknown) => {
    fixture.observedRecording(runId, result, fence);
    await fixture.recordGate?.();
    if (fixture.rejectRecording) return null;
    if (fixture.loseOwnerDuringRecord) fixture.controller.abort();
    if (fixture.mismatchRecording) return { id: "foreign-span", attemptRef: { id: "foreign-attempt" } };
    fixture.sealed = true;
    fixture.events.push("span_sealed");
    return { id: "span", attemptRef: fixture.run.runtimeAttemptRef };
  },
  finalizeRun: fixture.finalize,
  finishRuntimeAttempt: async () => {},
  appendTranscriptEntry: async () => {},
}) }));
vi.mock("./runtime-kernel/model-fallback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-kernel/model-fallback.js")>();
  return { ...actual, executeAdapterWithModelFallbacks: async (
    _adapter: unknown, context: { onLog?: (stream: "stdout", chunk: string) => Promise<void> }, options: Parameters<typeof actual.executeAdapterWithModelFallbacks>[2],
  ) => {
    if (fixture.stopResult) {
      const attempt: ModelAttemptSpec = { index: 0, agentRuntimeType: fixture.runtimeType, model: "primary",
        config: null, isFallback: false, fallbackIndex: null, totalFallbacks: 0 };
      await options!.onAttemptStart!(attempt, { type: fixture.runtimeType,
        parseStdoutLine: (line: string) => [JSON.parse(line)] } as any);
      options!.onProviderDispatch?.(attempt);
      await context.onLog?.("stdout", JSON.stringify({ kind: "assistant", text: "Visible partial response", delta: true }) + "\n");
      fixture.stop?.abort();
      await options!.onAttemptResult!(attempt, fixture.stopResult, "accepted", { providerDispatched: true, willFallback: false });
      if (fixture.repeatResult) {
        await options!.onAttemptResult!(attempt, fixture.repeatResult, "accepted", { providerDispatched: true, willFallback: false });
      }
      return fixture.stopResult;
    }
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
    fixture.runtimeType = "claude_local";
    fixture.stop = null;
    fixture.stopResult = null;
    fixture.repeatResult = null;
    fixture.rejectRecording = fixture.mismatchRecording = fixture.loseOwnerDuringRecord = false;
    fixture.recordGate = null;
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

describe("production Chat Stop terminal evidence (mocked fenced persistence)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.events.length = 0;
    fixture.sealed = false;
    fixture.runtimeType = "hermes_gateway";
    fixture.controller = new AbortController();
    fixture.stop = new AbortController();
    fixture.rejectRecording = fixture.mismatchRecording = fixture.loseOwnerDuringRecord = false;
    fixture.recordGate = null;
    fixture.run.runtimeSpanOwnerToken = "owner";
    fixture.run.runtimeAttemptRef = { id: "attempt", attemptIndex: 0 };
    fixture.repeatResult = null;
    fixture.observer.mockResolvedValue(undefined);
    fixture.finalize.mockResolvedValue(undefined);
    fixture.stopResult = {
      exitCode: 1, signal: "SIGTERM", timedOut: false, submissionPhase: "accepted",
      resultJson: { providerStatus: "interrupted", control: { interruptRequested: true, stopConfirmed: true,
        privatePrompt: "must-not-persist" }, privatePrompt: "must-not-persist" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_stop_ack" },
    };
  });

  const execute = () => chatAssistantService(db as any).streamChatAssistantReply({
    conversation: { id: "side", orgId: "org", conversationKind: "chat", planMode: false },
    messages: [{ id: "message", role: "user", body: "current input", attachments: [] }],
    userMessageId: "message", contextLinks: [], stream: true, abortSignal: fixture.stop!.signal,
  } as any);
  const terminal = () => fixture.finalize.mock.calls[0]?.[1];

  it("preserves observed native Stop evidence after fenced recording in the actual Chat caller", async () => {
    await expect(execute()).resolves.toMatchObject({ outcome: "stopped", partialBody: "Visible partial response" });
    expect(fixture.finalize).toHaveBeenCalledOnce();
    expect(terminal()).toMatchObject({ status: "cancelled", errorCode: "chat_stopped",
      resultJson: { outcome: "stopped", partialBody: "Visible partial response",
        control: { interruptRequested: true, stopConfirmed: true }, providerStatus: "interrupted",
        nativeWriterQuiescence: { status: "confirmed", source: "provider_stop_ack" },
        nativeStopEvidence: { orgId: "org", runId: "run", spanId: "span", attemptId: "attempt", attemptEpoch: 1 } } });
    expect(terminal().resultJson.control).toEqual({ interruptRequested: true, stopConfirmed: true });
    expect(JSON.stringify(terminal())).not.toContain("must-not-persist");
    expect(fixture.observedRecording.mock.invocationCallOrder[0]).toBeLessThan(fixture.finalize.mock.invocationCallOrder[0]!);
  });

  it("preserves explicit false and unconfirmed status without copying diagnostic secrets", async () => {
    fixture.stopResult!.resultJson = { providerStatus: "unknown", control: { interruptRequested: true, stopConfirmed: false } };
    fixture.stopResult!.nativeWriterQuiescence = { status: "unconfirmed", reason: "secret must-not-persist" };
    await execute();
    expect(terminal().resultJson.control).toEqual({ interruptRequested: true, stopConfirmed: false });
    expect(terminal().resultJson.nativeWriterQuiescence).toEqual({ status: "unconfirmed" });
    expect(JSON.stringify(terminal())).not.toContain("must-not-persist");
  });

  it("does not turn interrupt ACK or inconsistent unconfirmed proof into stopConfirmed true", async () => {
    fixture.stopResult!.nativeWriterQuiescence = { status: "unconfirmed", reason: "ACK only" };
    await execute();
    expect(terminal().resultJson.control?.stopConfirmed).not.toBe(true);
    expect(terminal().resultJson.nativeWriterQuiescence).toEqual({ status: "unconfirmed" });
  });

  it("does not overwrite previously observed confirmed evidence with a duplicate false result", async () => {
    fixture.repeatResult = { ...fixture.stopResult!, resultJson: { providerStatus: "unknown",
      control: { interruptRequested: true, stopConfirmed: false } },
    nativeWriterQuiescence: { status: "unconfirmed", reason: "duplicate" } };
    await execute();
    expect(terminal().resultJson.control?.stopConfirmed).toBe(true);
    expect(terminal().resultJson.providerStatus).toBe("interrupted");
    expect(terminal().resultJson.nativeWriterQuiescence).toEqual({ status: "confirmed", source: "provider_stop_ack" });
  });

  it.each(["rejectRecording", "mismatchRecording"] as const)("retains no provider evidence when %s fails the existing fence", async (key) => {
    fixture[key] = true;
    await execute();
    expect(terminal().resultJson).toEqual({ outcome: "stopped", partialBody: "Visible partial response",
      retention: { transcriptSource: "legacy" } });
  });

  it("cannot publish stopped evidence after owner loss while recording awaited", async () => {
    let entered!: () => void;
    let release!: () => void;
    const recording = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    fixture.recordGate = async () => { entered(); await held; };
    const pending = execute();
    await recording;
    fixture.controller.abort();
    release();
    await pending;
    expect(terminal()?.resultJson?.control?.stopConfirmed).not.toBe(true);
  });

  it.each(["owner", "attempt"] as const)("cannot attach stale proof when %s identity changes during recording", async (changed) => {
    let entered!: () => void;
    let release!: () => void;
    const recording = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    fixture.recordGate = async () => { entered(); await held; };
    const pending = execute();
    await recording;
    if (changed === "owner") fixture.run.runtimeSpanOwnerToken = "successor-owner";
    else fixture.run.runtimeAttemptRef = { id: "successor-attempt", attemptIndex: 1 };
    release();
    await pending;
    expect(terminal()?.resultJson).not.toHaveProperty("nativeStopEvidence");
    expect(terminal()?.resultJson?.control?.stopConfirmed).not.toBe(true);
    if (changed === "owner") expect(fixture.run.runtimeSpanOwnerToken).toBe("successor-owner");
    else expect(fixture.run.runtimeAttemptRef.id).toBe("successor-attempt");
  });

  it("leaves pre-dispatch Stop unchanged, with no invented native control evidence", async () => {
    fixture.stop!.abort();
    await execute();
    expect(terminal().resultJson).toEqual({ outcome: "stopped", partialBody: "",
      retention: { transcriptSource: "legacy" } });
    expect(fixture.observedRecording).toHaveBeenCalledWith("run", expect.objectContaining({
      submissionPhase: "pre_submission", nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
    }), expect.objectContaining({ orgId: "org", spanId: "span", attemptId: "attempt", ownerToken: "owner", attemptEpoch: 1 }));
  });

  it("leaves natural completion application terminal shape unchanged", async () => {
    fixture.stop = null;
    fixture.stopResult = { exitCode: 0, signal: null, timedOut: false, summary: "Visible partial response",
      resultJson: { providerStatus: "complete", control: { interruptRequested: false, stopConfirmed: false } },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" } };
    await chatAssistantService(db as any).streamChatAssistantReply({
      conversation: { id: "side", orgId: "org", conversationKind: "chat", planMode: false },
      messages: [{ id: "message", role: "user", body: "current input", attachments: [] }],
      userMessageId: "message", contextLinks: [], stream: true,
    } as any);
    expect(terminal()).toMatchObject({ status: "succeeded", resultJson: { outcome: "completed", body: "Visible partial response" } });
    expect(terminal().resultJson).not.toHaveProperty("control");
    expect(terminal().resultJson).not.toHaveProperty("nativeStopEvidence");
  });
});
