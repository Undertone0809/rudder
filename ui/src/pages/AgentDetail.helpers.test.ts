import { describe, expect, it } from "vitest";
import { readInvocationAgentInstructionStack, readInvocationMcpServerList } from "./AgentDetail.helpers";

describe("readInvocationAgentInstructionStack", () => {
  it("prefers the explicit full instruction stack over the legacy prompt", () => {
    expect(readInvocationAgentInstructionStack({
      prompt: "Follow the heartbeat.",
      agentInstructionStack: "# Rudder Agent Operating Contract\n\n# SOUL.md",
    })).toBe("# Rudder Agent Operating Contract\n\n# SOUL.md");
  });

  it("falls back to prompt for older adapter invoke events", () => {
    expect(readInvocationAgentInstructionStack({
      prompt: "Legacy invocation prompt",
    })).toBe("Legacy invocation prompt");
  });
});

describe("readInvocationMcpServerList", () => {
  it("distinguishes historical unknown evidence from a known empty inventory", () => {
    expect(readInvocationMcpServerList({})).toBeNull();
    expect(readInvocationMcpServerList({ loadedMcpServers: [] })).toEqual([]);
  });

  it("keeps only unique secret-free server evidence", () => {
    expect(readInvocationMcpServerList({
      loadedMcpServers: [
        { serverName: "rudder-tools", source: "built_in", proxyUrl: "https://secret.test" },
        { serverName: "external.supabase", source: "managed_external", bindingId: "private" },
        { serverName: "external.supabase", source: "managed_external" },
        { serverName: "invalid", source: "unknown" },
      ],
    })).toEqual([
      { serverName: "rudder-tools", source: "built_in" },
      { serverName: "external.supabase", source: "managed_external" },
    ]);
  });
});
