import { describe, expect, it } from "vitest";
import {
  MCP_PROVIDER_REGISTRY,
  resolveCuratedMcpEndpoint,
} from "./provider-registry.js";

describe("managed MCP provider registry", () => {
  it("keeps curated endpoint and onboarding behavior in one server-only registry", () => {
    expect(MCP_PROVIDER_REGISTRY).toMatchObject({
      supabase: {
        endpoint: "https://mcp.supabase.com/mcp",
        requiresOAuth: true,
        scopeSelection: "project",
        defaultAccessMode: "read_only",
        featureGroups: {
          mode: "provider_default",
          excluded: ["storage"],
        },
      },
      linear: {
        endpoint: "https://mcp.linear.app/mcp",
        readOnlyEndpoint: "https://mcp.linear.app/mcp/readonly",
        requiresOAuth: true,
        scopeSelection: "workspace",
        defaultAccessMode: "read_write",
        scopeIdentity: {
          toolNames: ["get_user"],
          arguments: { query: "me" },
          containers: ["workspace", "organization"],
        },
      },
      notion: {
        endpoint: "https://mcp.notion.com/mcp",
        requiresOAuth: true,
        scopeSelection: "workspace",
        defaultAccessMode: "provider_default",
        scopeIdentity: {
          toolNames: ["notion-fetch"],
          arguments: { id: "self" },
          containers: ["workspace", "organization"],
        },
      },
      custom: {
        endpoint: null,
        requiresOAuth: false,
        scopeSelection: "none",
      },
    });
  });

  it("requires a Supabase project and pins read-only by default", () => {
    expect(() => resolveCuratedMcpEndpoint({
      provider: "supabase",
      accessMode: "read_only",
      externalScope: null,
    })).toThrow(/project/i);

    const resolved = resolveCuratedMcpEndpoint({
      provider: "supabase",
      accessMode: "read_only",
      externalScope: "project-alpha",
    });

    expect(resolved.href).toBe(
      "https://mcp.supabase.com/mcp?project_ref=project-alpha&read_only=true",
    );
    expect(resolved.transport).toBe("streamable_http");
  });

  it("selects Linear read/write and read-only endpoints without provider logic in adapters", () => {
    expect(resolveCuratedMcpEndpoint({
      provider: "linear",
      accessMode: "read_write",
      externalScope: "workspace-a",
    }).href).toBe("https://mcp.linear.app/mcp");
    expect(resolveCuratedMcpEndpoint({
      provider: "linear",
      accessMode: "read_only",
      externalScope: "workspace-a",
    }).href).toBe("https://mcp.linear.app/mcp/readonly");
  });

  it("rejects custom providers because their URL comes from validated connection config", () => {
    expect(() => resolveCuratedMcpEndpoint({
      provider: "custom",
      accessMode: "provider_default",
      externalScope: null,
    })).toThrow(/custom/i);
  });
});
