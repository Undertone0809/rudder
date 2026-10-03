import { describe, expect, it, vi } from "vitest";
import { getRuntimeDriver, type RuntimeDriver } from "../agent-runtimes/index.js";
import {
  admitSideChatRuntimeFork,
  type SideChatForkSource,
} from "./side-chat-runtime-admission.js";

const source: SideChatForkSource = {
  sourceConversationId: "source-conversation",
  sourceMessageId: "source-message",
  sourceRunId: "source-run",
  sourceBoundaryRef: "source-turn-7",
  sourceSpanId: "source-span-7",
  selectorJson: {
    kind: "codex_turn",
    threadId: "source-session",
    turnId: "source-turn-7",
  },
  session: {
    sessionId: "source-session",
    sessionDisplayId: "source-session",
    sessionParams: { sessionId: "source-session" },
  },
};

const targetBinding = {
  orgId: "org-1",
  hostId: "local",
  profileId: "codex-profile",
  workspaceBindingId: "workspace-1",
  capabilityRevision: "capability-1",
};

function fakeDriver(input: {
  forkStatus?: RuntimeDriver["capabilities"]["fork"]["status"];
  forkReason?: string;
  fork?: RuntimeDriver["fork"];
} = {}) {
  const fork = input.fork ?? vi.fn(async () => ({
    status: "supported" as const,
    value: {
      session: {
        sessionId: "child-session",
        sessionDisplayId: "child-session",
        sessionParams: { sessionId: "child-session", branch: "side-chat" },
      },
      boundary: "child-turn-1",
      sourceBoundary: "source-turn-7",
      continuity: "native" as const,
    },
  }));
  return {
    capabilities: {
      fork: {
        status: input.forkStatus ?? "supported",
        reason: input.forkReason ?? "profile-bound fork is available",
      },
      contextHandoff: {
        status: "supported",
        reason: "visible context handoff is available",
      },
    },
    fork,
  } as unknown as RuntimeDriver;
}

describe("Side Chat runtime admission", () => {
  it("calls a profile-bound provider fork and records fork session intent", async () => {
    const driver = fakeDriver();

    const admission = await admitSideChatRuntimeFork({
      driver,
      source,
      targetBinding,
    });

    expect(driver.fork).toHaveBeenCalledWith({
      session: source.session,
      boundary: "source-turn-7",
      selector: source.selectorJson,
      binding: targetBinding,
      signal: undefined,
    });
    expect(admission).toMatchObject({
      continuity: "native",
      sourceConversationId: "source-conversation",
      sourceMessageId: "source-message",
      sourceRunId: "source-run",
      sourceBoundaryRef: "source-turn-7",
      sourceSpanId: "source-span-7",
      downgradeReason: null,
      session: {
        sessionId: "child-session",
      },
      sessionIntent: {
        kind: "fork",
        sourceRunId: "source-run",
        sourceBoundaryRef: "source-turn-7",
        sessionId: "child-session",
      },
    });
  });

  it("uses context handoff only after an explicit unverified Cursor fork capability", async () => {
    const fork = vi.fn();
    const admission = await admitSideChatRuntimeFork({
      driver: fakeDriver({
        forkStatus: "unknown",
        forkReason: "Cursor has no verified provider-native boundary fork",
        fork,
      }),
      source,
      targetBinding,
    });

    expect(fork).not.toHaveBeenCalled();
    expect(admission).toMatchObject({
      continuity: "context_handoff",
      providerCapability: {
        status: "unknown",
        reason: "Cursor has no verified provider-native boundary fork",
      },
      downgradeReason: "provider_native_fork_unavailable: Cursor has no verified provider-native boundary fork",
      sourceBoundaryRef: "source-turn-7",
      sourceSpanId: "source-span-7",
      sessionIntent: { kind: "fresh" },
    });
    expect(admission.session).toBeNull();
  });

  it("uses the registered Cursor capability result with the profile binding", async () => {
    const driver = getRuntimeDriver("cursor", { providerBinding: targetBinding });
    expect(driver).not.toBeNull();
    expect(driver?.capabilities.fork).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("verified provider resolver"),
    });
    expect(driver?.capabilities.contextHandoff.status).toBe("supported");

    const admission = await admitSideChatRuntimeFork({
      driver,
      source,
      targetBinding,
    });

    expect(admission).toMatchObject({
      continuity: "context_handoff",
      providerCapability: { status: "unknown" },
      downgradeReason: expect.stringContaining("provider_native_fork_unavailable"),
      sourceConversationId: "source-conversation",
      sourceMessageId: "source-message",
      sourceRunId: "source-run",
      sourceBoundaryRef: "source-turn-7",
      sourceSpanId: "source-span-7",
      sessionIntent: { kind: "fresh" },
    });
    expect(admission.session).toBeNull();
  });

  it.each([
    ["source boundary", { sourceBoundaryRef: null }, "source_reply_has_no_native_boundary"],
    ["source selector", { selectorJson: null }, "source_reply_has_no_native_selector"],
    ["source session", { session: null }, "source_reply_has_no_native_session"],
  ] as const)("falls back when %s evidence is missing", async (_label, overrides, reason) => {
    const fork = vi.fn();
    const admission = await admitSideChatRuntimeFork({
      driver: fakeDriver({ fork }),
      source: { ...source, ...overrides },
      targetBinding,
    });

    expect(fork).not.toHaveBeenCalled();
    expect(admission.continuity).toBe("context_handoff");
    expect(admission.downgradeReason).toBe(reason);
    expect(admission.sourceBoundaryRef).toBe(
      "sourceBoundaryRef" in overrides ? overrides.sourceBoundaryRef : source.sourceBoundaryRef,
    );
  });

  it("does not convert a provider fork exception into a handoff", async () => {
    const driver = fakeDriver({
      fork: vi.fn(async () => {
        throw new Error("provider transport unavailable");
      }),
    });

    await expect(admitSideChatRuntimeFork({
      driver,
      source,
      targetBinding,
    })).rejects.toThrow("provider transport unavailable");
  });

  it("does not convert an explicit provider fork rejection into a handoff", async () => {
    const driver = fakeDriver({
      fork: vi.fn(async () => ({
        status: "unsupported" as const,
        capability: "fork" as const,
        reason: "Installed provider rejected boundary fork",
      })),
    });

    await expect(admitSideChatRuntimeFork({
      driver,
      source,
      targetBinding,
    })).rejects.toThrow(
      "Provider-native Side Chat fork unsupported: Installed provider rejected boundary fork",
    );
  });
});
