// @vitest-environment jsdom

import type {
  Agent,
  McpConnectionSummary,
  McpProviderAvailability,
  McpProviderCatalogEntry,
} from "@rudderhq/shared";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  OrganizationMcpSettings,
  buildCustomMcpPayload,
  canReconnectManagedMcp,
  defaultCustomMcpForm,
  officialAccessChangeRequiresAuthorization,
  officialProviderAction,
  reserveAuthorizationLauncher,
} from "./OrganizationMcpSettings";

const mockOrganizationMcpData = vi.hoisted(() => ({
  catalog: [] as McpProviderCatalogEntry[],
  statuses: [] as McpProviderAvailability[],
  connections: [] as McpConnectionSummary[],
  agents: [] as Agent[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey.includes("mcp-provider-status")
      ? mockOrganizationMcpData.statuses
      : queryKey.includes("mcp-connections")
        ? mockOrganizationMcpData.connections
        : queryKey.includes("agents")
          ? mockOrganizationMcpData.agents
        : mockOrganizationMcpData.catalog,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    cleanup: () => act(() => root.unmount()),
  };
}

describe("managed MCP authorization launcher", () => {
  it("uses the existing Desktop external-navigation bridge without opening a popup", async () => {
    const openExternal = vi.fn(async () => undefined);
    const forceOpenExternal = vi.fn(async () => undefined);
    const openWindow = vi.fn<typeof window.open>(() => null);
    const launcher = reserveAuthorizationLauncher({
      desktopShell: { openExternal, forceOpenExternal },
      openWindow,
    });

    await launcher.navigate("https://oauth.example.test/authorize");

    expect(openWindow).not.toHaveBeenCalled();
    expect(forceOpenExternal).toHaveBeenCalledWith("https://oauth.example.test/authorize");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("falls back to the standard Desktop external-navigation bridge", async () => {
    const openExternal = vi.fn(async () => undefined);
    const launcher = reserveAuthorizationLauncher({
      desktopShell: { openExternal },
      openWindow: vi.fn<typeof window.open>(() => null),
    });

    await launcher.navigate("https://oauth.example.test/authorize");

    expect(openExternal).toHaveBeenCalledWith("https://oauth.example.test/authorize");
  });

  it("keeps synchronous popup reservation for the browser flow", async () => {
    const replace = vi.fn();
    const close = vi.fn();
    const reservedWindow = {
      opener: null,
      location: { replace },
      close,
    } as unknown as Window;
    const openWindow = vi.fn<typeof window.open>(() => reservedWindow);
    const launcher = reserveAuthorizationLauncher({
      desktopShell: null,
      openWindow,
    });

    await launcher.navigate("https://oauth.example.test/authorize");
    launcher.close();

    expect(openWindow).toHaveBeenCalledWith("about:blank", "_blank");
    expect(replace).toHaveBeenCalledWith("https://oauth.example.test/authorize");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not create a browser launcher when popup reservation is rejected", async () => {
    expect(() => reserveAuthorizationLauncher({
      desktopShell: null,
      openWindow: () => null,
    })).toThrow("Allow pop-ups for Rudder, then try again");
  });
});

describe("managed MCP authorization recovery", () => {
  it("allows an authorizing connection to restart OAuth when external navigation failed", () => {
    expect(canReconnectManagedMcp("authorizing")).toBe(true);
  });
});

describe("official provider card actions", () => {
  it("uses one clear action for each lifecycle state", () => {
    expect(officialProviderAction("not_connected", null)).toBe("Connect");
    expect(officialProviderAction("connecting", "account")).toBe("Continue setup");
    expect(officialProviderAction("connected", "account")).toBe("Manage");
    expect(officialProviderAction("needs_attention", "workspace")).toBe("Reconnect");
    expect(officialProviderAction("connected", "legacy_project")).toBe("Upgrade to account access");
  });

  it("stages every Supabase and Linear access change through OAuth", () => {
    expect(officialAccessChangeRequiresAuthorization("supabase", "read_only", "read_write")).toBe(true);
    expect(officialAccessChangeRequiresAuthorization("supabase", "read_write", "read_only")).toBe(true);
    expect(officialAccessChangeRequiresAuthorization("linear", "read_only", "read_write")).toBe(true);
    expect(officialAccessChangeRequiresAuthorization("linear", "read_write", "read_only")).toBe(true);
    expect(officialAccessChangeRequiresAuthorization("notion", "provider_default", "provider_default")).toBe(false);
    expect(officialAccessChangeRequiresAuthorization("github", "read_only", "read_write")).toBe(false);
    expect(officialAccessChangeRequiresAuthorization("custom", "provider_default", "read_only")).toBe(false);
  });
});

describe("organization MCP interaction", () => {
  it("defaults a new connection to Organization and offers eligible agents", () => {
    mockOrganizationMcpData.catalog = [{
      id: "supabase",
      label: "Supabase",
      curated: true,
      requiresOAuth: true,
      credentialMode: "oauth",
      requiresScopeSelection: false,
      scopeLabel: "Account",
      transports: ["streamable_http"],
      accessModes: ["read_only", "read_write"],
      defaultAccessMode: "read_write",
    }];
    mockOrganizationMcpData.statuses = [{
      provider: "supabase",
      organization: {
        state: "not_connected",
        connectionId: null,
        maxAccess: null,
        scopeMode: null,
        revision: null,
        agentConnectionCount: 0,
      },
    }];
    mockOrganizationMcpData.connections = [];
    mockOrganizationMcpData.agents = [{
      id: "agent-1",
      orgId: "org-1",
      name: "Noah",
      urlKey: "noah",
      role: "engineer",
      title: null,
      icon: null,
      status: "active",
      capabilities: null,
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: {
        canCreateAgents: false,
        canManageSkills: false,
      },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }];
    const { container, cleanup } = render(createElement(OrganizationMcpSettings, { orgId: "org-1" }));
    const card = container.querySelector('[data-testid="mcp-provider-supabase"]')!;
    act(() => [...card.querySelectorAll("button")]
      .find((button) => button.textContent === "Connect")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const target = document.body.querySelector('select[aria-label="Enable for"]') as HTMLSelectElement;
    expect(target.value).toBe("organization");
    expect(target.className).toContain("appearance-none");
    expect(target.parentElement?.querySelector('[data-testid="connection-target-chevron"]')).not.toBeNull();
    expect([...target.options].map((option) => option.textContent)).toEqual([
      "Organization",
      "Noah",
    ]);

    cleanup();
    document.body.innerHTML = "";
  });

  it("keeps discovery and management compact and opens a provider dialog", () => {
    const now = new Date("2026-07-25T00:00:00.000Z");
    mockOrganizationMcpData.catalog = [{
      id: "supabase",
      label: "Supabase",
      curated: true,
      requiresOAuth: true,
      credentialMode: "oauth",
      requiresScopeSelection: false,
      scopeLabel: "Account",
      transports: ["streamable_http"],
      accessModes: ["read_only", "read_write"],
      defaultAccessMode: "read_only",
    }];
    mockOrganizationMcpData.statuses = [{
      provider: "supabase",
      organization: {
        state: "connected",
        connectionId: "supabase-connection",
        maxAccess: "read_only",
        scopeMode: "account",
        revision: 2,
        historicalGrantConnectionIds: [
          "superseded-supabase-connection",
        ],
      },
    }];
    mockOrganizationMcpData.connections = [{
      id: "supabase-connection",
      orgId: "org-1",
      name: "supabase",
      displayName: "Supabase",
      provider: "supabase",
      scope: "organization",
      ownerAgentId: null,
      transport: "streamable_http",
      externalScope: null,
      accessMode: "read_only",
      status: "active",
      safeConfig: {},
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
      enabled: true,
      required: false,
      hasCredentials: true,
      lastDiscoveredAt: now,
      activatedAt: now,
      disabledAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    }];
    const { container, cleanup } = render(createElement(OrganizationMcpSettings, { orgId: "org-1" }));

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("Tool allowlist");
    expect(container.querySelector('select[aria-label="Project"]')).toBeNull();

    const providerCard = container.querySelector('[data-testid="mcp-provider-supabase"]')!;
    const providerManage = [...providerCard.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");
    act(() => providerManage?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Manage Supabase");
    expect(dialog?.textContent).toContain("Maximum access");
    expect(dialog?.textContent).toContain("1 historical authorization");
    expect(dialog?.textContent).toContain("Disconnect historical access");
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Discover");

    cleanup();
    document.body.innerHTML = "";
  });

  it("asks for a GitHub PAT before starting a provider connection", () => {
    mockOrganizationMcpData.catalog = [{
      id: "github",
      label: "GitHub",
      curated: true,
      requiresOAuth: false,
      credentialMode: "pat",
      requiresScopeSelection: false,
      scopeLabel: "Account",
      transports: ["streamable_http"],
      accessModes: ["read_only", "read_write"],
      defaultAccessMode: "read_only",
    }];
    mockOrganizationMcpData.statuses = [{
      provider: "github",
      organization: {
        state: "not_connected",
        connectionId: null,
        maxAccess: null,
        scopeMode: null,
        revision: null,
        agentConnectionCount: 0,
      },
    }];
    mockOrganizationMcpData.connections = [];
    mockOrganizationMcpData.agents = [];
    const { container, cleanup } = render(createElement(OrganizationMcpSettings, { orgId: "org-1" }));
    const card = container.querySelector('[data-testid="mcp-provider-github"]')!;
    act(() => [...card.querySelectorAll("button")]
      .find((button) => button.textContent === "Connect")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const pat = document.body.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(pat?.getAttribute("placeholder")).toBe("github_pat_...");
    expect(document.body.textContent).toContain("GitHub personal access token");

    cleanup();
    document.body.innerHTML = "";
  });
});

describe("custom MCP connection form", () => {
  it("stores every literal HTTP header as encrypted credential material", () => {
    const form = defaultCustomMcpForm();
    form.displayName = "Release MCP";
    form.url = "https://mcp.example.com/mcp";
    form.headers = [
      { id: "1", key: "X-Workspace", value: "docs" },
      { id: "2", key: "Authorization", value: "Bearer secret-token" },
      { id: "4", key: "X-Access-Token", value: "secondary-secret" },
      { id: "5", key: "X-Client-Key", value: "client-secret" },
    ];
    form.headersFromEnvironment = [
      { id: "3", key: "X-Region", value: "MCP_REGION" },
    ];
    const payload = buildCustomMcpPayload(form);

    expect(payload).toMatchObject({
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.com/mcp",
        headersFromEnv: { "X-Region": "MCP_REGION" },
        secretHeaderNames: [
          "X-Workspace",
          "Authorization",
          "X-Access-Token",
          "X-Client-Key",
        ],
      },
      secrets: {
        headers: {
          "X-Workspace": "docs",
          Authorization: "Bearer secret-token",
          "X-Access-Token": "secondary-secret",
          "X-Client-Key": "client-secret",
        },
      },
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
    });
    expect(JSON.stringify(payload.safeConfig)).not.toContain("secret-token");
    expect(JSON.stringify(payload.safeConfig)).not.toContain("secondary-secret");
    expect(JSON.stringify(payload.safeConfig)).not.toContain("client-secret");
    expect(payload.safeConfig).not.toHaveProperty("toolAllowlist");
    expect(payload.safeConfig).not.toHaveProperty("toolDenylist");
  });

  it("stores STDIO values as secrets and keeps only names in safe config", () => {
    const form = defaultCustomMcpForm();
    form.displayName = "Local database";
    form.transport = "stdio";
    form.command = "npx";
    form.arguments = [
      { id: "1", value: "-y" },
      { id: "2", value: "@example/mcp-server,with-comma" },
    ];
    form.cwd = "/workspace";
    form.environment = [{ id: "1", key: "DATABASE_URL", value: "postgres://secret" }];
    form.forwardedEnvText = "PATH, NODE_EXTRA_CA_CERTS";

    const payload = buildCustomMcpPayload(form);

    expect(payload).toMatchObject({
      provider: "custom",
      transport: "stdio",
      safeConfig: {
        command: "npx",
        args: ["-y", "@example/mcp-server,with-comma"],
        cwd: "/workspace",
        forwardedEnv: ["PATH", "NODE_EXTRA_CA_CERTS"],
        secretEnvNames: ["DATABASE_URL"],
      },
      secrets: {
        env: { DATABASE_URL: "postgres://secret" },
      },
    });
    expect(JSON.stringify(payload.safeConfig)).not.toContain("postgres://secret");
  });

  it("rejects conflicting Authorization sources before sending the request", () => {
    const form = defaultCustomMcpForm();
    form.displayName = "Conflicting auth";
    form.url = "https://mcp.example.com/mcp";
    form.bearerTokenEnvVar = "MCP_TOKEN";
    form.headers = [{ id: "1", key: "Authorization", value: "Bearer secret" }];

    expect(() => buildCustomMcpPayload(form)).toThrow(/only one Authorization or Bearer/i);
  });
});
