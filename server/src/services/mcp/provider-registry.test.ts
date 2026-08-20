import { describe, expect, it } from "vitest";
import {
  MCP_CURATED_OAUTH_ORIGINS,
  MCP_GITHUB_READ_ONLY_OAUTH_SCOPE,
  MCP_GITHUB_READ_WRITE_OAUTH_SCOPE,
  MCP_PROVIDER_REGISTRY,
  resolveCuratedMcpEndpoint,
  resolveCuratedMcpOAuthScope,
} from "./provider-registry.js";

describe("managed MCP provider registry", () => {
  it("keeps curated endpoint and onboarding behavior in one server-only registry", () => {
    expect(MCP_PROVIDER_REGISTRY).toMatchObject({
      supabase: {
        endpoint: "https://mcp.supabase.com/mcp",
        oauthOrigins: ["https://mcp.supabase.com", "https://api.supabase.com"],
        requiresOAuth: true,
        scopeSelection: "none",
        defaultAccessMode: "read_only",
        featureGroups: {
          mode: "provider_default",
          excluded: ["storage"],
        },
      },
      linear: {
        endpoint: "https://mcp.linear.app/mcp",
        oauthOrigins: ["https://mcp.linear.app"],
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
        oauthOrigins: ["https://mcp.notion.com"],
        requiresOAuth: true,
        scopeSelection: "workspace",
        defaultAccessMode: "provider_default",
        scopeIdentity: {
          toolNames: ["notion-fetch"],
          arguments: { id: "self" },
          containers: ["workspace", "organization"],
        },
      },
      github: {
        endpoint: "https://api.githubcopilot.com/mcp/",
        oauthOrigins: ["https://api.githubcopilot.com", "https://github.com"],
        oauthScopes: {
          read_only: MCP_GITHUB_READ_ONLY_OAUTH_SCOPE,
          read_write: MCP_GITHUB_READ_WRITE_OAUTH_SCOPE,
        },
        requiresOAuth: true,
        credentialMode: "oauth",
        scopeMode: "account",
        scopeSelection: "none",
        defaultAccessMode: "read_only",
      },
      custom: {
        endpoint: null,
        oauthOrigins: [],
        requiresOAuth: false,
        credentialMode: "custom",
        scopeSelection: "none",
      },
    });
    expect(MCP_CURATED_OAUTH_ORIGINS).toEqual([
      "https://mcp.supabase.com",
      "https://api.supabase.com",
      "https://mcp.linear.app",
      "https://mcp.notion.com",
      "https://api.githubcopilot.com",
      "https://github.com",
    ]);
  });

  it("uses an account-scoped Supabase endpoint without project_ref", () => {
    const readOnly = resolveCuratedMcpEndpoint({
      provider: "supabase",
      accessMode: "read_only",
      externalScope: null,
    });
    const readWrite = resolveCuratedMcpEndpoint({
      provider: "supabase",
      accessMode: "read_write",
      externalScope: null,
    });

    expect(readOnly.href).toBe("https://mcp.supabase.com/mcp?read_only=true");
    expect(readWrite.href).toBe("https://mcp.supabase.com/mcp?read_only=false");
    expect(new URL(readOnly.href).searchParams.has("project_ref")).toBe(false);
    expect(readOnly.transport).toBe("streamable_http");
  });

  it("preserves the project boundary for a legacy Supabase reconnect", () => {
    const endpoint = resolveCuratedMcpEndpoint({
      provider: "supabase",
      accessMode: "read_only",
      externalScope: "legacy-project-ref",
    });

    expect(new URL(endpoint.href).searchParams.get("project_ref"))
      .toBe("legacy-project-ref");
    expect(new URL(endpoint.href).searchParams.get("read_only")).toBe("true");
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

  it("resolves GitHub to its fixed account endpoint and advertises OAuth origins", () => {
    expect(resolveCuratedMcpEndpoint({
      provider: "github",
      accessMode: "read_only",
      externalScope: null,
    })).toEqual({
      href: "https://api.githubcopilot.com/mcp/",
      transport: "streamable_http",
    });
    expect(() => resolveCuratedMcpEndpoint({
      provider: "github",
      accessMode: "provider_default",
      externalScope: null,
    })).toThrow(/read_only|read_write/i);
    expect(MCP_CURATED_OAUTH_ORIGINS).toContain("https://api.githubcopilot.com");
    expect(MCP_CURATED_OAUTH_ORIGINS).toContain("https://github.com");
  });

  it("pins GitHub OAuth scopes to the selected access mode", () => {
    expect(resolveCuratedMcpOAuthScope({
      provider: "github",
      accessMode: "read_only",
    })).toBe("read:org read:user user:email read:packages read:project");
    expect(resolveCuratedMcpOAuthScope({
      provider: "github",
      accessMode: "read_write",
    })).toBe(MCP_GITHUB_READ_WRITE_OAUTH_SCOPE);

    const readOnlyScopes = MCP_GITHUB_READ_ONLY_OAUTH_SCOPE.split(" ");
    expect(readOnlyScopes).not.toContain("repo");
    expect(readOnlyScopes).not.toContain("delete_repo");
    expect(readOnlyScopes).not.toContain("workflow");
    expect(readOnlyScopes).not.toContain("write:packages");
  });

  it("rejects custom providers because their URL comes from validated connection config", () => {
    expect(() => resolveCuratedMcpEndpoint({
      provider: "custom",
      accessMode: "provider_default",
      externalScope: null,
    })).toThrow(/custom/i);
  });
});
