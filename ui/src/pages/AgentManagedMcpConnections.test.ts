import type { McpAgentConnectionSummary } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { buildManagedMcpBindingUpdate } from "./AgentManagedMcpConnections";

describe("buildManagedMcpBindingUpdate", () => {
  it("saves coarse access with optimistic concurrency", () => {
    const row = {
      binding: {
        id: "binding-1",
        status: "active",
        policyRevision: 4,
      },
    } as McpAgentConnectionSummary;

    expect(buildManagedMcpBindingUpdate(row, "read_only")).toEqual({
      accessMode: "read_only",
      expectedRevision: 4,
      status: "active",
    });
  });

  it("creates a first binding without inventing a revision", () => {
    expect(buildManagedMcpBindingUpdate(
      { binding: null } as McpAgentConnectionSummary,
      "full",
    )).toEqual({
      accessMode: "full",
      status: "active",
    });
  });

  it("turns no access into an explicit disabled binding", () => {
    const row = {
      binding: {
        id: "binding-1",
        status: "active",
        policyRevision: 2,
      },
    } as McpAgentConnectionSummary;

    expect(buildManagedMcpBindingUpdate(row, "none")).toEqual({
      accessMode: "none",
      expectedRevision: 2,
      status: "disabled",
    });
  });
});
