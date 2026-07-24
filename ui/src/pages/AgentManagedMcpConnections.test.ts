import type { McpAgentConnectionSummary } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { buildManagedMcpBindingUpdate } from "./AgentManagedMcpConnections";

describe("buildManagedMcpBindingUpdate", () => {
  it("never requests binding reactivation while updating an existing allowlist", () => {
    const row = {
      binding: {
        id: "binding-1",
        status: "active",
      },
    } as McpAgentConnectionSummary;

    expect(buildManagedMcpBindingUpdate(row, ["tool-1"])).toEqual({
      enabledToolIds: ["tool-1"],
    });
    expect(buildManagedMcpBindingUpdate(row, ["tool-1"])).not.toHaveProperty("status");
  });

  it("keeps first-time binding creation on the server default path", () => {
    expect(buildManagedMcpBindingUpdate(
      { binding: null } as McpAgentConnectionSummary,
      ["tool-1"],
      true,
    )).toEqual({});
  });

  it("requests reactivation only for an explicit bind of an existing revoked binding", () => {
    const row = {
      binding: {
        id: "binding-1",
        status: "revoked",
      },
    } as McpAgentConnectionSummary;

    expect(buildManagedMcpBindingUpdate(row, ["tool-1"], true)).toEqual({
      status: "active",
      enabledToolIds: ["tool-1"],
    });
  });
});
