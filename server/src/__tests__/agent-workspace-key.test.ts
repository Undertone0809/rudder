import { describe, expect, it } from "vitest";
import {
  buildAgentWorkspaceKey,
  deriveUniqueAgentWorkspaceKey,
  resolveStoredOrDerivedAgentWorkspaceKey,
} from "../agent-workspace-key.js";

describe("agent workspace key", () => {
  it("builds slug--shortid from the stored agent name and id", () => {
    expect(buildAgentWorkspaceKey("Codex Coder", "88acd103-e62a-400b-92ff-7b45620998a9"))
      .toBe("codex-coder--88acd103");
  });

  it("falls back to agent when the name normalizes to empty", () => {
    expect(buildAgentWorkspaceKey("!!!", "88acd103-e62a-400b-92ff-7b45620998a9"))
      .toBe("agent--88acd103");
  });

  it("extends the uuid slice when the short candidate collides", () => {
    expect(
      deriveUniqueAgentWorkspaceKey({
        agentId: "88acd103-e62a-400b-92ff-7b45620998a9",
        name: "Codex Coder",
        existingKeys: ["codex-coder--88acd103"],
      }),
    ).toBe("codex-coder--88acd103e62a");
  });

  it("prefers the stored workspace key so rename does not move the canonical directory", () => {
    expect(
      resolveStoredOrDerivedAgentWorkspaceKey({
        id: "88acd103-e62a-400b-92ff-7b45620998a9",
        name: "Renamed Later",
        workspaceKey: "codex-coder--88acd103",
      }),
    ).toBe("codex-coder--88acd103");
  });

  it("falls back to a hash seed when the agent id is not uuid-like", () => {
    expect(buildAgentWorkspaceKey("Budget Agent", "agent-1"))
      .toMatch(/^budget-agent--[a-f0-9]{8}$/);
  });
});
