import { describe, expect, it } from "vitest";
import { resolveCodexAgentHome } from "./execute.js";

describe("resolveCodexAgentHome", () => {
  const base = {
    configuredAgentHome: "",
    cwd: "/tmp/rudder-product-intelligence",
    runtimeScene: "product_intelligence",
    effectiveCodexHome: "/tmp/rudder/organizations/org-1/codex-home/agents/product-intelligence-lightweight",
    agentId: "product-intelligence-lightweight",
  };

  it("keeps product intelligence in its temporary cwd", () => {
    expect(resolveCodexAgentHome(base)).toBe("/tmp/rudder-product-intelligence");
  });

  it("preserves an explicitly configured agent home", () => {
    expect(resolveCodexAgentHome({
      ...base,
      configuredAgentHome: "/tmp/explicit-agent-home",
    })).toBe("/tmp/explicit-agent-home");
  });

  it("keeps the persisted agent fallback for normal runs", () => {
    expect(resolveCodexAgentHome({
      ...base,
      runtimeScene: "heartbeat",
    })).toBe("/tmp/rudder/organizations/org-1/workspaces/agents/product-intelligence-lightweight");
  });
});
