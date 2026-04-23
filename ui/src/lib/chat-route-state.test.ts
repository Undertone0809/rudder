// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveRequestedPreferredAgentId } from "./chat-route-state";

describe("chat route state", () => {
  const agents = [
    { id: "agent-active", status: "active" as const },
    { id: "agent-idle", status: "idle" as const },
    { id: "agent-terminated", status: "terminated" as const },
  ];

  it("ignores empty requested agent ids", () => {
    expect(resolveRequestedPreferredAgentId("", agents)).toBeNull();
    expect(resolveRequestedPreferredAgentId("   ", agents)).toBeNull();
    expect(resolveRequestedPreferredAgentId(null, agents)).toBeNull();
  });

  it("returns null when the requested agent is unknown", () => {
    expect(resolveRequestedPreferredAgentId("missing-agent", agents)).toBeNull();
  });

  it("returns null when the requested agent is terminated", () => {
    expect(resolveRequestedPreferredAgentId("agent-terminated", agents)).toBeNull();
  });

  it("returns the matching active agent id", () => {
    expect(resolveRequestedPreferredAgentId("agent-active", agents)).toBe("agent-active");
    expect(resolveRequestedPreferredAgentId(" agent-idle ", agents)).toBe("agent-idle");
  });
});
