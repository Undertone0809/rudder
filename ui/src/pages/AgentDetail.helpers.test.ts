import { describe, expect, it } from "vitest";
import { formatInvocationValueForCopy, formatInvocationValueForDisplay, readInvocationAgentInstructionStack, readInvocationMcpServerList } from "./AgentDetail.helpers";

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

describe("formatInvocationValueForDisplay", () => {
  it("keeps historical invocation UUIDs compact and typed when their field identifies the entity", () => {
    const agentId = "d573266f-af95-44e6-9303-e903a54662b8";
    const runId = "609695f1-f90a-4b17-be61-4f0c6fe37c42";
    const legacyPrompt = `run=${runId} asset=/api/assets/${runId}/content library=library-entry://${agentId}`;
    const prompt = formatInvocationValueForDisplay({ agentId, runId, prompt: legacyPrompt }, false);

    expect(prompt).toContain("agt_d573266f");
    expect(prompt).toContain("run_609695f1");
    expect(prompt).toContain(`/api/assets/${runId}/content`);
    expect(prompt).toContain(`library-entry://${agentId}`);
    expect(formatInvocationValueForCopy(legacyPrompt, false)).toBe(legacyPrompt);
  });
});
