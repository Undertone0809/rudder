import { describe, expect, it } from "vitest";
import {
  chatRuntimeInvocationSnapshot,
  queuedChatRuntimeInvocationSnapshot,
} from "../routes/chats.runtime-controls.js";

describe("chat runtime admission snapshots", () => {
  it("captures the effective Agent, model, and effort for a running turn", () => {
    expect(chatRuntimeInvocationSnapshot({
      runtimeAgentId: "agent-1",
      model: "gpt-5.6-sol",
      effort: "high",
    })).toEqual({
      agentIdSnapshot: "agent-1",
      modelSnapshot: "gpt-5.6-sol",
      effortSnapshot: "high",
    });
  });

  it("restores only server-versioned queued Agent/runtime snapshots", () => {
    const payload = {
      agentId: "agent-1",
      model: "gpt-5.6-terra",
      effort: "xhigh",
    };
    expect(queuedChatRuntimeInvocationSnapshot({
      runtimeSnapshotVersion: 1,
      payload,
    })).toEqual({
      agentIdSnapshot: "agent-1",
      modelSnapshot: "gpt-5.6-terra",
      effortSnapshot: "xhigh",
    });
    expect(queuedChatRuntimeInvocationSnapshot({
      runtimeSnapshotVersion: null,
      payload,
    })).toEqual({});
    expect(queuedChatRuntimeInvocationSnapshot({
      runtimeSnapshotVersion: 1,
      payload: { model: "legacy-model", effort: "medium" },
    })).toEqual({
      modelSnapshot: "legacy-model",
      effortSnapshot: "medium",
    });
  });
});
