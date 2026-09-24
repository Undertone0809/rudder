import type {
  AgentRuntimeExecutionResult,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatRuntimeDriver } from "./heartbeat.admission.js";
import type { NativeSessionState, RuntimeBindingInput, RuntimeBindingRecord } from "./native-session.js";
import { currentNativeSession, ensureRuntimeBinding } from "./native-session.js";
import type { UnifiedAgentRunAdapter } from "./unified-agent-run.contracts.js";
import type { UnifiedAgentRunEntry, UnifiedOwnerFence } from "./unified-agent-run.js";

vi.mock("./native-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./native-session.js")>();
  return {
    ...actual,
    currentNativeSession: vi.fn(),
    ensureRuntimeBinding: vi.fn(),
  };
});

const result: AgentRuntimeExecutionResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  summary: "ok",
};

function adapter(): ServerAgentRuntimeModule {
  return {
    type: "codex_local",
    execute: vi.fn(async () => result),
    testEnvironment: async (context) => ({
      agentRuntimeType: context.agentRuntimeType,
      status: "pass",
      checks: [],
      testedAt: new Date().toISOString(),
    }),
  };
}

describe("heartbeat Runtime Driver production ports", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds the existing session, Unified Run, and approval owners", async () => {
    const binding = {
      id: "binding-1",
      orgId: "org-1",
      runtimeType: "codex_local",
      hostId: "local",
      profileId: "default",
      workspaceBindingId: null,
      capabilityRevision: "unknown",
    } as RuntimeBindingRecord;
    const state = {
      binding,
      segment: { id: "segment-1", bindingId: binding.id, runtimeType: "codex_local", state: "pending" },
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
    } as NativeSessionState;
    vi.mocked(ensureRuntimeBinding).mockResolvedValue(binding);
    vi.mocked(currentNativeSession).mockResolvedValue(state);

    const fence: UnifiedOwnerFence = {
      id: "span-1",
      ownerToken: "owner-1",
      attemptEpoch: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const entry = {
      runId: "run-1",
      orgId: "org-1",
      status: "running",
      ownerFence: fence,
      attempt: { ref: { id: "attempt-1", attemptIndex: 0 }, runtimeType: "codex_local" },
    } as unknown as UnifiedAgentRunEntry;
    const unifiedRunAdapter = {
      get: vi.fn(async () => entry),
      reconcileAcceptance: vi.fn(async () => ({ ok: true as const, value: { state: "accepted" } })),
    } as unknown as UnifiedAgentRunAdapter;
    const approvalBridge = {
      requestApproval: vi.fn(async () => ({ id: "approval-1", status: "pending" as const })),
      waitForApproval: vi.fn(async () => ({ id: "approval-1", status: "approved" as const })),
    };
    const db = {} as Db;
    const driver = createHeartbeatRuntimeDriver(
      { db, unifiedRunAdapter },
      "codex_local",
      { adapter: adapter(), approvalBridge },
    );

    expect(driver?.capabilities).toMatchObject({
      sessionBinding: { status: "supported" },
      executionInspection: { status: "supported" },
      executionReconciliation: { status: "supported" },
      requestResponse: { status: "supported" },
    });

    const intent: RuntimeBindingInput = {
      orgId: "org-1",
      agentId: "agent-1",
      runtimeType: "codex_local",
      target: { type: "issue", id: "issue-1" },
    };
    await expect(driver?.ensureSession(intent)).resolves.toMatchObject({
      status: "supported",
      value: { binding: { id: "binding-1" }, segmentId: "segment-1" },
    });
    expect(ensureRuntimeBinding).toHaveBeenCalledWith(db, intent);
    expect(currentNativeSession).toHaveBeenCalledWith(db, binding);

    await expect(driver?.inspectExecution({ runId: "run-1", attemptId: "attempt-1" })).resolves.toMatchObject({
      status: "supported",
      value: { state: "found", entry },
    });
    await expect(driver?.reconcileExecution({
      runId: "run-1",
      attemptId: "attempt-1",
      fence,
      outcome: { state: "accepted", submissionKey: "submission-1" },
    })).resolves.toMatchObject({ status: "supported", value: { ok: true } });
    expect(unifiedRunAdapter.get).toHaveBeenCalledWith("run-1");
    expect(unifiedRunAdapter.reconcileAcceptance).toHaveBeenCalledWith(
      "run-1",
      fence,
      expect.objectContaining({ state: "accepted", submissionKey: "submission-1" }),
    );

    await expect(driver?.respondToRequest({ type: "agent_runtime", payload: {} }, 1_000)).resolves.toMatchObject({
      status: "supported",
      value: { handle: { id: "approval-1" }, decision: { status: "approved" } },
    });
    expect(approvalBridge.requestApproval).toHaveBeenCalledOnce();
    expect(approvalBridge.waitForApproval).toHaveBeenCalledWith("approval-1", 1_000);
  });
});
