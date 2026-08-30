import { describe, expect, it } from "vitest";
import {
  RUDDER_AGENT_CONTRACT,
  RUDDER_AGENT_CONTRACT_HASH,
  normalizeRudderAgentContractValue,
} from "./rudder-agent-contract.js";
import {
  RUDDER_MCP_TOOL_DESCRIPTORS,
} from "./rudder-mcp-tool-descriptors.generated.js";

describe("Rudder agent contract", () => {
  it("projects complete CLI, MCP, and current direct API descriptor sets", () => {
    expect(RUDDER_AGENT_CONTRACT.capabilities).toHaveLength(117);
    expect(RUDDER_AGENT_CONTRACT.capabilities.filter((capability) => capability.mcp)).toHaveLength(106);
    expect(RUDDER_AGENT_CONTRACT.capabilities.filter((capability) => capability.api.transport === "direct")).toHaveLength(48);
    expect(RUDDER_AGENT_CONTRACT.capabilities.find((capability) => capability.id === "issue.checkout")?.api).toEqual({
      method: "POST",
      pathTemplate: "/api/issues/{issue}/checkout",
      transport: "direct",
    });
    expect(RUDDER_AGENT_CONTRACT.capabilities.find((capability) => capability.id === "issue.review")?.api).toEqual({
      transport: "cli-fallback",
    });
  });

  it("normalizes every differential fixture using only its explicit profile", () => {
    expect(RUDDER_AGENT_CONTRACT.differentialFixtures.map((fixture) => fixture.id)).toEqual([
      "success",
      "authorization",
      "validation",
      "bounded-output",
      "cancellation",
      "runtime-context-error",
    ]);
    for (const fixture of [
      ...RUDDER_AGENT_CONTRACT.differentialFixtures,
      ...RUDDER_AGENT_CONTRACT.g0DifferentialFixtures,
    ]) {
      expect(normalizeRudderAgentContractValue(fixture.left, fixture.profile)).toEqual(fixture.expected);
      expect(normalizeRudderAgentContractValue(fixture.right, fixture.profile)).toEqual(fixture.expected);
    }
  });

  it("covers the G0 authority overlay with production-shaped parity scenarios", () => {
    expect(RUDDER_AGENT_CONTRACT.g0DifferentialFixtures.map((fixture) => fixture.id)).toEqual([
      "goal-typed-reference-ambiguity",
      "organization-fencing",
      "member-filter-pagination",
      "skill-search-match",
      "skill-search-empty",
      "plugin-projection-reference",
      "plugin-not-found",
      "issue-create-defaults-attribution",
    ]);
  });

  it("preserves semantic differences outside the enumerated pointer allowlist", () => {
    const normalized = normalizeRudderAgentContractValue({
      status: "error",
      error: { code: "forbidden" },
      meta: { requestId: "request-1" },
    }, "authorization");
    expect(normalized).toEqual({
      status: "error",
      error: { code: "forbidden" },
      meta: { requestId: "<non-semantic>" },
    });
    expect(normalized).not.toEqual({
      status: "error",
      error: { code: "unauthorized" },
      meta: { requestId: "<non-semantic>" },
    });
  });

  it("keeps the generated MCP descriptors aligned with the source capabilities", () => {
    expect(RUDDER_MCP_TOOL_DESCRIPTORS.map((descriptor) => descriptor.capabilityId)).toEqual(
      RUDDER_AGENT_CONTRACT.capabilities.flatMap((capability) => capability.mcp ? [capability.id] : []),
    );
    expect(RUDDER_AGENT_CONTRACT_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
});
