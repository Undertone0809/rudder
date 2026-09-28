import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RUDDER_AGENT_CONTRACT,
  RUDDER_AGENT_CONTRACT_HASH,
  normalizeRudderAgentContractValue,
} from "./rudder-agent-contract.js";
import {
  GENERATED_RUDDER_AGENT_CONTRACT_HASH,
  GENERATED_RUDDER_BROWSER_MCP_CONTRACT_HASH,
  GENERATED_RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_MCP_TOOL_DESCRIPTORS,
} from "./rudder-mcp-tool-descriptors.generated.js";
import { fingerprintRudderMcpToolManifest, stableRudderMcpContractJson } from "./rudder-mcp-fingerprint.js";

const SOURCE_CONTRACT = JSON.parse(readFileSync(
  new URL("../../../contracts/rudder-agent-contract/v1.json", import.meta.url),
  "utf8",
)) as typeof RUDDER_AGENT_CONTRACT;

describe("Rudder agent contract", () => {
  it("projects complete CLI, MCP, and current direct API descriptor sets", () => {
    expect(RUDDER_AGENT_CONTRACT.capabilities).toHaveLength(119);
    expect(RUDDER_AGENT_CONTRACT.capabilities.filter((capability) => capability.mcp)).toHaveLength(108);
    expect(RUDDER_AGENT_CONTRACT.capabilities.filter((capability) => capability.api.transport === "direct")).toHaveLength(51);
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

  it("reassembles generated shards with exact source content, ordering, and contract hashes", () => {
    const sourceHash = createHash("sha256")
      .update(stableRudderMcpContractJson(SOURCE_CONTRACT))
      .digest("hex");
    const sourceTools = SOURCE_CONTRACT.capabilities.flatMap(({ mcp }) => mcp ? [{
      name: mcp.name,
      description: mcp.description,
      inputSchema: mcp.inputSchema,
    }] : []);
    const expectedDescriptors = SOURCE_CONTRACT.capabilities.flatMap((capability) => capability.mcp ? [{
      capabilityId: capability.id,
      name: capability.mcp.name,
      description: capability.cli.description,
      semanticDescription: capability.mcp.description,
      annotations: capability.mcp.annotations,
      mutating: capability.cli.mutating,
      requiresOrgId: capability.cli.requiresOrgId,
      requiresAgentId: capability.cli.requiresAgentId,
      attachesRunIdWhenAvailable: capability.cli.attachesRunIdWhenAvailable,
      inputSchema: capability.mcp.inputSchema,
    }] : []);

    expect(stableRudderMcpContractJson(RUDDER_AGENT_CONTRACT)).toBe(
      stableRudderMcpContractJson(SOURCE_CONTRACT),
    );
    expect(stableRudderMcpContractJson(RUDDER_MCP_TOOL_DESCRIPTORS)).toBe(
      stableRudderMcpContractJson(expectedDescriptors),
    );
    expect(RUDDER_AGENT_CONTRACT_HASH).toBe(sourceHash);
    expect(GENERATED_RUDDER_AGENT_CONTRACT_HASH).toBe(sourceHash);
    expect(GENERATED_RUDDER_CORE_MCP_CONTRACT_HASH).toBe(fingerprintRudderMcpToolManifest(
      sourceTools.filter(({ name }) => !name.startsWith("rudder_browser_")),
    ));
    expect(GENERATED_RUDDER_BROWSER_MCP_CONTRACT_HASH).toBe(fingerprintRudderMcpToolManifest(
      sourceTools.filter(({ name }) => name.startsWith("rudder_browser_")),
    ));
  });

  it("exposes Project update idempotency as optional in both generated MCP contracts", () => {
    const capability = RUDDER_AGENT_CONTRACT.capabilities.find(({ id }) => id === "project.update");
    const descriptor = RUDDER_MCP_TOOL_DESCRIPTORS.find(({ capabilityId }) => capabilityId === "project.update");
    const capabilitySchema = capability?.mcp?.inputSchema as {
      properties: Record<string, unknown>;
      required?: readonly string[];
    } | undefined;
    const descriptorSchema = descriptor?.inputSchema as {
      properties: Record<string, unknown>;
      required?: readonly string[];
    } | undefined;

    expect(capabilitySchema?.properties).toHaveProperty("idempotencyKey");
    expect(capabilitySchema?.required).not.toContain("idempotencyKey");
    expect(descriptorSchema?.properties).toHaveProperty("idempotencyKey");
    expect(descriptorSchema?.required).not.toContain("idempotencyKey");
  });
});
