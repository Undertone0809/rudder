import { describe, expect, it } from "vitest";
import { classifyAgentRuntimeNetworkFailure } from "./network-suspension.js";

describe("classifyAgentRuntimeNetworkFailure", () => {
  it("classifies a pre-submission connection failure as safe pristine replay", () => {
    expect(classifyAgentRuntimeNetworkFailure({
      message: "connect ECONNREFUSED provider.example",
      provider: "openai",
      model: "gpt-5",
    })).toMatchObject({
      kind: "network_unavailable",
      transport: "connection",
      submissionPhase: "pre_submission",
      continuation: "fresh_if_pristine",
      sideEffectRisk: "none",
    });
  });

  it("keeps auth, quota, and tool failures terminal", () => {
    expect(classifyAgentRuntimeNetworkFailure({
      message: "connection reset after MCP tool network error",
      toolActivityObserved: true,
    })).toBeNull();
    expect(classifyAgentRuntimeNetworkFailure({
      message: "429 rate limit exceeded",
    })).toBeNull();
    expect(classifyAgentRuntimeNetworkFailure({
      message: "401 invalid api key; connection failed",
    })).toBeNull();
  });

  it("requires a same-session resume once a provider session exists", () => {
    expect(classifyAgentRuntimeNetworkFailure({
      message: "stream disconnected",
      sessionId: "provider-session-1",
      modelOutputObserved: true,
    })).toMatchObject({
      submissionPhase: "accepted",
      continuation: "resume_same_session",
      sideEffectRisk: "possible",
    });
  });
});
