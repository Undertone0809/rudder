import { describe, expect, it } from "vitest";
import {
  classifyManagedMcpTool,
  isManagedMcpToolCapabilityAllowed,
  MCP_TOOL_DISCOVERY_LIMITS,
  normalizeMcpDiscoveredTools,
  reconcileMcpBindingToolNames,
  reconcileMcpToolCatalog,
} from "./tool-discovery.js";

describe("managed MCP capability policy", () => {
  it("classifies known provider tools and fails closed for destructive or unknown tools", () => {
    expect(classifyManagedMcpTool("supabase", "list_tables")).toBe("read");
    expect(classifyManagedMcpTool("supabase", "apply_migration")).toBe("destructive");
    expect(classifyManagedMcpTool("supabase", "apply_migrations")).toBe("destructive");
    expect(classifyManagedMcpTool("supabase", "run_migration")).toBe("destructive");
    expect(classifyManagedMcpTool("supabase", "execute_ddl")).toBe("destructive");
    expect(classifyManagedMcpTool("supabase", "alter_table")).toBe("destructive");
    expect(classifyManagedMcpTool("supabase", "delete_branch")).toBe("destructive");
    expect(classifyManagedMcpTool("supabase", "get_publishable_keys")).toBe("admin_or_billing");
    expect(classifyManagedMcpTool("linear", "get_issue")).toBe("read");
    expect(classifyManagedMcpTool("linear", "create_issue")).toBe("normal_write");
    expect(classifyManagedMcpTool("notion", "notion-search")).toBe("read");
    expect(classifyManagedMcpTool("notion", "notion-create-pages")).toBe("normal_write");
    expect(classifyManagedMcpTool("linear", "get_or_create_issue")).toBe("normal_write");
    expect(classifyManagedMcpTool("linear", "search_and_update_issue")).toBe("normal_write");
    expect(classifyManagedMcpTool("notion", "read_then_publish")).toBe("normal_write");
    expect(classifyManagedMcpTool("custom", "search")).toBe("unknown");
    expect(classifyManagedMcpTool("supabase", "brand_new_tool")).toBe("unknown");
  });

  it("derives the effective tool surface from coarse agent access", () => {
    expect(isManagedMcpToolCapabilityAllowed("none", "read")).toBe(false);
    expect(isManagedMcpToolCapabilityAllowed("read_only", "read")).toBe(true);
    expect(isManagedMcpToolCapabilityAllowed("read_only", "normal_write")).toBe(false);
    expect(isManagedMcpToolCapabilityAllowed("read_write", "normal_write")).toBe(true);
    expect(isManagedMcpToolCapabilityAllowed("read_write", "destructive")).toBe(false);
    expect(isManagedMcpToolCapabilityAllowed("read_write", "admin_or_billing")).toBe(false);
    expect(isManagedMcpToolCapabilityAllowed("read_write", "unknown")).toBe(false);
    expect(isManagedMcpToolCapabilityAllowed("provider_granted", "read")).toBe(true);
    expect(isManagedMcpToolCapabilityAllowed("provider_granted", "normal_write")).toBe(true);
    expect(isManagedMcpToolCapabilityAllowed("full", "unknown")).toBe(true);
  });
});

describe("managed MCP tool discovery normalization", () => {
  it("keeps raw schemas, exposes sanitized schemas, and gives tools a stable connection prefix", () => {
    const [tool] = normalizeMcpDiscoveredTools("finance-team", [{
      name: "search_invoices",
      description: " Search invoices ",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: {
          count: { type: "integer" },
        },
      },
    }]);

    expect(tool).toMatchObject({
      externalToolName: "search_invoices",
      rudderToolName: "external.finance-team.search_invoices",
      description: "Search invoices",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    });
    expect(tool?.rawInputSchema).toEqual(tool?.inputSchema);
    expect(tool?.rawInputSchema).not.toBe(tool?.inputSchema);
  });

  it("removes prototype-pollution keys from exposed schemas without mutating Object.prototype", () => {
    const schema = JSON.parse(
      "{\"type\":\"object\",\"properties\":{\"safe\":{\"type\":\"string\"}},\"__proto__\":{\"polluted\":true},\"constructor\":{\"prototype\":{\"polluted\":true}}}",
    ) as Record<string, unknown>;

    const [tool] = normalizeMcpDiscoveredTools("safe", [{
      name: "inspect",
      inputSchema: schema,
    }]);

    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(tool?.rawInputSchema).toHaveProperty("__proto__");
    expect(tool?.inputSchema).not.toHaveProperty("__proto__");
    expect(tool?.inputSchema).not.toHaveProperty("constructor");
  });

  it("rejects tool count, name, schema byte-size, depth, and invalid JSON Schema boundaries", () => {
    const validTool = {
      name: "valid",
      inputSchema: { type: "object" },
    };
    expect(() => normalizeMcpDiscoveredTools(
      "team",
      Array.from({ length: MCP_TOOL_DISCOVERY_LIMITS.maxTools + 1 }, (_, index) => ({
        ...validTool,
        name: `tool-${index}`,
      })),
    )).toThrow(/tool count/i);

    expect(() => normalizeMcpDiscoveredTools("team", [{
      ...validTool,
      name: "x".repeat(MCP_TOOL_DISCOVERY_LIMITS.maxToolNameCharacters + 1),
    }])).toThrow(/tool name/i);

    expect(() => normalizeMcpDiscoveredTools("team", [{
      ...validTool,
      inputSchema: {
        type: "object",
        description: "x".repeat(MCP_TOOL_DISCOVERY_LIMITS.maxSchemaBytes),
      },
    }])).toThrow(/schema size/i);

    let nested: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth <= MCP_TOOL_DISCOVERY_LIMITS.maxSchemaDepth; depth += 1) {
      nested = { type: "array", items: nested };
    }
    expect(() => normalizeMcpDiscoveredTools("team", [{
      ...validTool,
      inputSchema: nested,
    }])).toThrow(/schema depth/i);

    expect(() => normalizeMcpDiscoveredTools("team", [{
      ...validTool,
      inputSchema: { type: "definitely-not-a-json-schema-type" },
    }])).toThrow(/JSON Schema/i);
  });

  it("rejects non-ASCII protocol names and enforces the 128-character boundary", () => {
    expect(() => normalizeMcpDiscoveredTools("team", [{
      name: "x".repeat(128),
      inputSchema: { type: "object" },
    }])).not.toThrow();
    for (const name of ["read tool", "read/tool", "工具", "x".repeat(129)]) {
      expect(() => normalizeMcpDiscoveredTools("team", [{
        name,
        inputSchema: { type: "object" },
      }])).toThrow(/tool name/i);
    }
  });

  it("gives case-fold collisions deterministic distinct names", () => {
    const tools = normalizeMcpDiscoveredTools("team", [
      { name: "Read", inputSchema: { type: "object" } },
      { name: "read", inputSchema: { type: "object" } },
    ]);

    expect(new Set(tools.map((tool) => tool.rudderToolName)).size).toBe(2);
    expect(tools.map((tool) => tool.rudderToolName)).toEqual(
      normalizeMcpDiscoveredTools("team", [
        { name: "Read", inputSchema: { type: "object" } },
        { name: "read", inputSchema: { type: "object" } },
      ]).map((tool) => tool.rudderToolName),
    );
  });

  it("applies exact custom allowlist and denylist filters before exposing schemas", () => {
    const tools = normalizeMcpDiscoveredTools("filtered", [
      { name: "read_rows", inputSchema: { type: "object" } },
      { name: "write_rows", inputSchema: { type: "object" } },
      { name: "delete_rows", inputSchema: { type: "object" } },
    ], {
      toolAllowlist: ["read_rows", "write_rows"],
      toolDenylist: ["write_rows"],
    });

    expect(tools.map((tool) => tool.externalToolName)).toEqual(["read_rows"]);
  });

  it("truncates and hashes namespaced tool names to a stable 128 characters", () => {
    const input = [{
      name: "x".repeat(128),
      inputSchema: { type: "object" },
    }];
    const [first] = normalizeMcpDiscoveredTools("c".repeat(80), input);
    const [second] = normalizeMcpDiscoveredTools("c".repeat(80), input);

    expect(first?.rudderToolName).toBe(second?.rudderToolName);
    expect(first?.rudderToolName.length).toBeLessThanOrEqual(128);
    expect(first?.rudderToolName).toMatch(/^external\.[a-z0-9_-]+\.[a-z0-9_-]+-[a-f0-9]{8}$/u);
  });
});

describe("managed MCP schema drift", () => {
  it("marks missing tools removed and leaves newly discovered tools active", () => {
    expect(reconcileMcpToolCatalog(
      [
        { externalToolName: "kept", enabled: true },
        { externalToolName: "gone", enabled: true },
      ],
      [
        { externalToolName: "kept" },
        { externalToolName: "new" },
      ],
    )).toEqual([
      { externalToolName: "kept", enabled: true, status: "active", isNew: false },
      { externalToolName: "new", enabled: true, status: "active", isNew: true },
      { externalToolName: "gone", enabled: false, status: "removed", isNew: false },
    ]);
  });

  it("restores tools that reappear without overriding an explicit active disable", () => {
    expect(reconcileMcpToolCatalog(
      [
        { externalToolName: "returned", enabled: false, status: "removed" },
        { externalToolName: "manually_disabled", enabled: false, status: "active" },
      ],
      [
        { externalToolName: "returned" },
        { externalToolName: "manually_disabled" },
      ],
    )).toEqual([
      { externalToolName: "returned", enabled: true, status: "active", isNew: false },
      { externalToolName: "manually_disabled", enabled: false, status: "active", isNew: false },
    ]);
  });

  it("enables all current tools on the first binding but not newly discovered tools later", () => {
    expect(reconcileMcpBindingToolNames({
      initialBinding: true,
      previouslyKnownToolNames: [],
      previouslyEnabledToolNames: [],
      currentToolNames: ["search", "create"],
    })).toEqual(["search", "create"]);

    expect(reconcileMcpBindingToolNames({
      initialBinding: false,
      previouslyKnownToolNames: ["search", "gone"],
      previouslyEnabledToolNames: ["search", "gone"],
      currentToolNames: ["search", "new"],
    })).toEqual(["search"]);
  });
});
