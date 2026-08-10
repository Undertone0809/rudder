// @vitest-environment jsdom

import {
  RUDDER_AGENT_V1_MCP_SERVER_NAME,
  RUDDER_BROWSER_MCP_SERVER_NAME,
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_CORE_MCP_TOOL_NAMES,
  type AgentBrowserToolSummary,
  type AgentDetail,
  type AgentIntegrationSummary,
  type AgentRudderToolSummary,
  type CustomIntegrationSummary,
  type McpAgentConnectionSummary,
  type McpProviderAvailability,
} from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { AgentIntegrationsTab, getFeishuIntegrationState } from "./AgentDetail.integrations";

const mockWindowOpen = vi.fn();

const mockInvalidateQueries = vi.hoisted(() => vi.fn());
const mockManagedMcpApi = vi.hoisted(() => ({
  ensureOfficialConnection: vi.fn(),
  startOAuth: vi.fn(),
}));
const mockCustomIntegrationsData = vi.hoisted(() => ({
  rows: [] as CustomIntegrationSummary[],
}));
const mockManagedMcpConnectionsData = vi.hoisted(() => ({
  rows: [] as McpAgentConnectionSummary[],
  failed: false,
}));
const mockManagedMcpProviderStatusData = vi.hoisted(() => ({
  rows: [] as McpProviderAvailability[],
  failed: false,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ initialData, queryKey }: { initialData?: unknown; queryKey?: readonly unknown[] }) => ({
    data: queryKey?.includes("custom-integrations")
      ? mockCustomIntegrationsData.rows
      : queryKey?.includes("mcp-provider-status")
        ? mockManagedMcpProviderStatusData.rows
      : queryKey?.includes("mcp-connections")
        ? mockManagedMcpConnectionsData.rows
        : initialData,
    isLoading: false,
    isError: queryKey?.includes("mcp-provider-status")
      ? mockManagedMcpProviderStatusData.failed
      : queryKey?.includes("mcp-connections")
        ? mockManagedMcpConnectionsData.failed
        : false,
    refetch: vi.fn(),
  }),
  useMutation: (options: { mutationFn?: (arg?: unknown) => Promise<unknown>; onSuccess?: (result: unknown) => void | Promise<void> }) => ({
    mutate: vi.fn(async (arg?: unknown) => {
      const result = await options.mutationFn?.(arg);
      await options.onSuccess?.(result);
    }),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: vi.fn(),
  }),
}));

vi.mock("react-router-dom", () => ({
  useLocation: () => ({
    pathname: "/R6z/agents/agent-1",
    search: "",
    hash: "",
    state: null,
  }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    integrationSetupUrl: vi.fn().mockResolvedValue({
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?name=Wesley+-+Rudder",
      suggestedBotName: "Wesley - Rudder",
      expiresAt: null,
    }),
    startFeishuSetupSession: vi.fn().mockResolvedValue({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?name=Wesley+-+Rudder",
      suggestedBotName: "Wesley - Rudder",
      status: "waiting_for_authorization",
      statusDetail: "Waiting for Feishu authorization",
      expiresAt: new Date("2026-06-18T01:10:00.000Z"),
      integration: null,
    }),
    getFeishuSetupSession: vi.fn().mockResolvedValue({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?name=Wesley+-+Rudder",
      suggestedBotName: "Wesley - Rudder",
      status: "waiting_for_authorization",
      statusDetail: "Waiting for Feishu authorization",
      expiresAt: new Date("2026-06-18T01:10:00.000Z"),
      integration: null,
    }),
    listIntegrations: vi.fn(),
    revokeIntegration: vi.fn(),
    updateIntegrationSettings: vi.fn(),
    listCustomIntegrations: vi.fn(),
    createCustomIntegration: vi.fn(),
    revokeCustomIntegration: vi.fn(),
    listMcpConnections: vi.fn(),
    listMcpProviderStatus: vi.fn(),
    updateMcpConnectionBinding: vi.fn(),
    revokeMcpConnectionBinding: vi.fn(),
  },
}));

vi.mock("../api/managedMcp", () => ({
  managedMcpApi: mockManagedMcpApi,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

Object.defineProperty(window, "open", {
  configurable: true,
  value: mockWindowOpen,
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  mockCustomIntegrationsData.rows = [];
  mockManagedMcpConnectionsData.rows = [];
  mockManagedMcpConnectionsData.failed = false;
  mockManagedMcpProviderStatusData.rows = [];
  mockManagedMcpProviderStatusData.failed = false;
  mockManagedMcpApi.ensureOfficialConnection.mockReset();
  mockManagedMcpApi.startOAuth.mockReset();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  act(() => {
    root.render(element);
  });
  return container;
}

async function waitForAssertion(assertion: () => void | Promise<void>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function agent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: "agent-1",
    orgId: "org-1",
    name: "Wesley",
    urlKey: "wesley",
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
    permissions: { canCreateAgents: false, canManageSkills: true },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-06-18T00:00:00.000Z"),
    updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    access: { membership: null, grants: [], canAssignTasks: false, taskAssignSource: "none" },
    instructionsLibraryPath: null,
    rudderTools: [rudderToolSummary(), browserToolSummary()],
    integrations: [],
    ...overrides,
  };
}

function rudderToolSummary(overrides: Partial<AgentRudderToolSummary> = {}): AgentRudderToolSummary {
  return {
    id: RUDDER_AGENT_V1_MCP_SERVER_NAME,
    displayName: "Rudder MCP tools",
    kind: "rudder_mcp",
    status: "available",
    scope: "runtime",
    serverName: RUDDER_AGENT_V1_MCP_SERVER_NAME,
    contract: "agent-v1",
    toolCount: RUDDER_CORE_MCP_TOOL_NAMES.length,
    tools: [...RUDDER_CORE_MCP_TOOL_NAMES],
    authMode: "runtime_managed",
    cliFallbackAvailable: true,
    ...overrides,
  };
}

function browserToolSummary(overrides: Partial<AgentBrowserToolSummary> = {}): AgentBrowserToolSummary {
  return {
    id: RUDDER_BROWSER_MCP_SERVER_NAME,
    displayName: "Rudder Browser",
    kind: "rudder_browser_mcp",
    status: "available",
    scope: "runtime",
    serverName: RUDDER_BROWSER_MCP_SERVER_NAME,
    contract: "browser-v1",
    toolCount: RUDDER_BROWSER_MCP_TOOL_NAMES.length,
    tools: [...RUDDER_BROWSER_MCP_TOOL_NAMES],
    authMode: "runtime_managed",
    cliFallbackAvailable: false,
    ...overrides,
  };
}

function integration(overrides: Partial<AgentIntegrationSummary> = {}): AgentIntegrationSummary {
  return {
    id: "integration-1",
    orgId: "org-1",
    agentId: "agent-1",
    provider: "feishu",
    status: "active",
    transport: "long_connection",
    providerRegion: "feishu_cn",
    hasCredentialSecret: true,
    externalAppId: "cli_a_app",
    externalBotOpenId: "ou_bot",
    externalTenantKey: null,
    installerUserId: null,
    manageUrl: "https://open.feishu.cn/app/cli_a_app",
    settings: {
      feishu: {
        dailySessionRolloverEnabled: true,
        dailySessionRolloverHours: 24,
        dailySessionRolloverNotifyFeishu: true,
      },
    },
    installedAt: new Date("2026-06-18T01:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-06-18T01:00:00.000Z"),
    updatedAt: new Date("2026-06-18T01:00:00.000Z"),
    ...overrides,
  };
}

function customIntegration(overrides: Partial<CustomIntegrationSummary> = {}): CustomIntegrationSummary {
  return {
    id: "custom-integration-1",
    orgId: "org-1",
    ownerAgentId: "agent-1",
    scope: "agent",
    kind: "mcp_server",
    slug: "linear-mcp",
    displayName: "Linear MCP",
    description: null,
    status: "active",
    config: {},
    hasCredentialSecret: true,
    binding: {
      id: "binding-1",
      orgId: "org-1",
      agentId: "agent-1",
      integrationId: "custom-integration-1",
      status: "active",
      enabledToolIds: ["tool-1"],
      createdAt: new Date("2026-06-18T01:00:00.000Z"),
      updatedAt: new Date("2026-06-18T01:00:00.000Z"),
      revokedAt: null,
    },
    tools: [
      {
        id: "tool-1",
        orgId: "org-1",
        integrationId: "custom-integration-1",
        externalToolName: "search_issues",
        rudderToolName: "custom.linear-mcp.search_issues",
        description: "Search issues",
        inputSchema: {},
        config: {},
        status: "active",
        enabled: true,
        createdAt: new Date("2026-06-18T01:00:00.000Z"),
        updatedAt: new Date("2026-06-18T01:00:00.000Z"),
      },
    ],
    createdAt: new Date("2026-06-18T01:00:00.000Z"),
    updatedAt: new Date("2026-06-18T01:00:00.000Z"),
    revokedAt: null,
    ...overrides,
  };
}

function managedMcpConnection(
  provider: "supabase" | "linear" | "notion" | "github",
  overrides: Partial<McpAgentConnectionSummary> = {},
): McpAgentConnectionSummary {
  const now = new Date("2026-07-24T12:00:00.000Z");
  return {
    connection: {
      id: `${provider}-connection`,
      orgId: "org-1",
      name: `${provider}-main`,
      displayName: provider[0]!.toUpperCase() + provider.slice(1),
      provider,
      scope: "organization",
      ownerAgentId: null,
      transport: "streamable_http",
      externalScope: provider === "github" ? null : `${provider}-workspace`,
      accessMode: provider === "notion" ? "provider_default" : "read_only",
      status: "active",
      safeConfig: provider === "github"
        ? {
            endpoint: "https://api.githubcopilot.com/mcp/",
            scopeMode: "account",
          }
        : {},
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
    },
    binding: null,
    reviewRequired: false,
    tools: [{
      id: `${provider}-tool`,
      connectionId: `${provider}-connection`,
      externalToolName: "search",
      rudderToolName: `external.${provider}.search`,
      description: `Search ${provider}`,
      inputSchema: {},
      outputSchema: null,
      capabilityClass: "read",
      policyRevision: 1,
      catalogRevision: 1,
      enabled: true,
      removedAt: null,
    }],
    ...overrides,
  };
}

function managedMcpProviderStatus(
  provider: "supabase" | "linear" | "notion" | "github",
  overrides: Partial<McpProviderAvailability> = {},
): McpProviderAvailability {
  return {
    provider,
    organization: {
      state: "connected",
      connectionId: `${provider}-connection`,
      maxAccess: provider === "notion" ? "provider_granted" : "read_write",
      scopeMode: provider === "supabase" || provider === "github" ? "account" : "workspace",
      revision: 3,
    },
    agent: {
      access: "none",
      activeRunUsesOlderPolicy: false,
      connection: null,
      effectiveSource: "organization",
      effectiveConnectionId: `${provider}-connection`,
      explicitlyDisabled: false,
    },
    ...overrides,
  };
}

describe("AgentIntegrationsTab", () => {
  it("renders a stable Feishu row when the agent has no integration", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);

    expect(container.textContent).not.toContain("Connect the external tools this agent can use during work loops.");
    expect(container.textContent).toContain("Discover");
    expect(container.textContent).toContain("Manage");
    expect(container.textContent).not.toContain("Built-in");
    expect(container.textContent).not.toContain("Rudder MCP tools");
    expect(container.textContent).not.toContain("rudder-tools");
    expect(container.textContent).not.toContain("runtime-managed auth");
    expect(container.textContent).toContain("Custom API");
    expect(container.textContent).not.toContain("MCP Server");
    expect(container.textContent).toContain("Supabase");
    expect(container.textContent).toContain("Notion");
    expect(container.textContent).toContain("Linear");
    expect(container.textContent?.match(/Not connected/g)?.length).toBe(4);
    expect(container.textContent).toContain("Feishu / Lark");
    expect(container.textContent).toContain("Not configured");
    expect(container.textContent).toContain("Set up");
    expect(container.textContent?.match(/Coming soon/g)?.length).toBe(3);
    expect(container.textContent).not.toContain("0 of 10 connected");
    expect(container.textContent).not.toContain("Create a Feishu bot named Wesley - Rudder");
  });

  it("reuses managed organization MCP state in the Agent integration catalog", () => {
    mockManagedMcpProviderStatusData.rows = [
      managedMcpProviderStatus("notion"),
      managedMcpProviderStatus("linear", {
        agent: {
          access: "read_only",
          activeRunUsesOlderPolicy: false,
          connection: null,
          effectiveSource: "organization",
          effectiveConnectionId: "linear-connection",
          explicitlyDisabled: false,
        },
      }),
    ];

    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const notionCard = container.querySelector('[data-testid="managed-mcp-provider-notion"]');
    const linearCard = container.querySelector('[data-testid="managed-mcp-provider-linear"]');
    const supabaseCard = container.querySelector('[data-testid="managed-mcp-provider-supabase"]');

    expect(notionCard?.textContent).toContain("Available");
    expect(notionCard?.textContent).not.toContain("Coming soon");
    expect(linearCard?.textContent).toContain("Read only");
    expect(linearCard?.textContent).not.toContain("tool enabled");
    expect(linearCard?.textContent).not.toContain("external.linear");
    expect(supabaseCard?.textContent).toContain("Not connected");
  });

  it("offers organization Custom MCP access from Discover without exposing its tool catalog", async () => {
    const base = managedMcpConnection("linear");
    mockManagedMcpConnectionsData.rows = [{
      ...base,
      connection: {
        ...base.connection,
        id: "custom-connection",
        name: "acceptance-mcp",
        displayName: "Acceptance MCP",
        provider: "custom",
        transport: "stdio",
        externalScope: null,
        accessMode: "provider_default",
        safeConfig: { command: "custom-mcp" },
      },
      tools: [{
        ...base.tools[0]!,
        id: "custom-tool",
        connectionId: "custom-connection",
        externalToolName: "inspect",
        rudderToolName: "external.acceptance-mcp.inspect",
        capabilityClass: "unknown",
      }],
    }];

    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const row = container.querySelector('[data-testid="agent-mcp-connection-custom-connection"]')!;

    expect(container.textContent).toContain("Organization MCPs");
    expect(row.textContent).toContain("Acceptance MCP");
    expect(row.textContent).toContain("No access");
    expect(row.textContent).not.toContain("inspect");

    const setAccess = [...row.querySelectorAll("button")]
      .find((button) => button.textContent === "Set access");
    act(() => {
      setAccess?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Manage Acceptance MCP access");
    expect(dialog.textContent).toContain("No access");
    expect(dialog.textContent).toContain("Full server access");
    expect(dialog.textContent).not.toContain("inspect");
    const full = [...dialog.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Full server access"))
      ?.querySelector('input[type="radio"]');
    act(() => {
      full?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const save = [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Save");
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(agentsApi.updateMcpConnectionBinding).toHaveBeenCalledWith(
      "agent-1",
      "custom-connection",
      {
        accessMode: "full",
        status: "active",
      },
      "org-1",
    );
  });

  it("does not misreport an unavailable managed MCP query as not connected", () => {
    mockManagedMcpProviderStatusData.failed = true;

    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const notionCard = container.querySelector('[data-testid="managed-mcp-provider-notion"]');

    expect(notionCard?.textContent).toContain("Unavailable");
    expect(notionCard?.textContent).not.toContain("Not connected");
  });

  it("shows an agent OAuth connection in progress without calling it explicitly disabled", () => {
    mockManagedMcpProviderStatusData.rows = [
      managedMcpProviderStatus("linear", {
        organization: {
          state: "not_connected",
          connectionId: null,
          maxAccess: null,
          scopeMode: null,
          revision: null,
        },
        agent: {
          access: "none",
          activeRunUsesOlderPolicy: false,
          connection: {
            state: "connecting",
            connectionId: "linear-agent-connection",
            maxAccess: "read_write",
            revision: 1,
          },
          effectiveSource: "none",
          effectiveConnectionId: null,
          explicitlyDisabled: false,
        },
      }),
    ];

    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const linearCard = container.querySelector('[data-testid="managed-mcp-provider-linear"]');

    expect(linearCard?.textContent).toContain("Connecting");
    expect(linearCard?.textContent).not.toContain("Disabled for this agent");
  });

  it("defaults Add connection to the current agent and also offers Organization", () => {
    mockManagedMcpProviderStatusData.rows = [
      managedMcpProviderStatus("supabase", {
        organization: {
          state: "not_connected",
          connectionId: null,
          maxAccess: null,
          scopeMode: null,
          revision: null,
        },
        agent: {
          access: "none",
          activeRunUsesOlderPolicy: false,
          connection: null,
          effectiveSource: "none",
          effectiveConnectionId: null,
          explicitlyDisabled: false,
        },
      }),
    ];
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const card = container.querySelector('[data-testid="managed-mcp-provider-supabase"]')!;
    act(() => [...card.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const manageDialog = document.body.querySelector('[role="dialog"]')!;
    act(() => [...manageDialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Add connection")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const target = document.body.querySelector('select[aria-label="Enable for"]') as HTMLSelectElement;
    expect(target.className).toContain("appearance-none");
    expect(target.parentElement?.querySelector('[data-testid="connection-target-chevron"]')).not.toBeNull();
    expect(target.value).toBe("agent");
    expect([...target.options].map((option) => option.textContent)).toEqual([
      "Wesley",
      "Organization",
    ]);
  });

  it("connects an agent-scoped GitHub connection with a PAT without opening OAuth", async () => {
    mockManagedMcpProviderStatusData.rows = [managedMcpProviderStatus("github", {
      organization: {
        state: "not_connected",
        connectionId: null,
        maxAccess: null,
        scopeMode: null,
        revision: null,
      },
      agent: {
        access: "none",
        activeRunUsesOlderPolicy: false,
        connection: null,
        effectiveSource: "none",
        effectiveConnectionId: null,
        explicitlyDisabled: false,
      },
    })];
    const githubConnection = managedMcpConnection("github").connection;
    mockManagedMcpApi.ensureOfficialConnection.mockResolvedValue(githubConnection);

    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const card = container.querySelector('[data-testid="managed-mcp-provider-github"]')!;
    act(() => {
      card.querySelector<HTMLButtonElement>('button[aria-label="Manage GitHub"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const manageDialog = document.body.querySelector('[role="dialog"]')!;
    act(() => {
      [...manageDialog.querySelectorAll("button")]
        .find((button) => button.textContent === "Add connection")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const targetDialog = document.body.querySelector('[role="dialog"]')!;
    const patInput = targetDialog.querySelector<HTMLInputElement>("#agent-github-pat")!;
    const connect = [...targetDialog.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Connect")) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    const pat = "github_pat_12345678901234567890";
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(patInput, pat);
      patInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const enabledConnect = [...targetDialog.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Connect")) as HTMLButtonElement;
    expect(enabledConnect.disabled).toBe(false);
    await act(async () => {
      enabledConnect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(mockManagedMcpApi.ensureOfficialConnection).toHaveBeenCalledWith(
      "org-1",
      "github",
      { scope: "agent", ownerAgentId: "agent-1", pat },
    );
    expect(mockManagedMcpApi.startOAuth).not.toHaveBeenCalled();
  });

  it("opens a focused access dialog instead of navigating to Manage", () => {
    mockManagedMcpProviderStatusData.rows = [
      managedMcpProviderStatus("linear", {
        agent: {
          access: "read_only",
          activeRunUsesOlderPolicy: false,
          connection: null,
          effectiveSource: "organization",
          effectiveConnectionId: "linear-connection",
          explicitlyDisabled: false,
        },
      }),
    ];

    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const linearCard = container.querySelector('[data-testid="managed-mcp-provider-linear"]');
    const manageButton = [...linearCard!.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");

    act(() => {
      manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Manage Linear access");
    expect(dialog?.textContent).toContain("No access");
    expect(dialog?.textContent).toContain("Read only");
    expect(dialog?.textContent).toContain("Read & write");
    expect(dialog?.textContent).not.toContain("external.linear");
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Discover");
  });

  it("closes the focused access dialog before opening organization settings", () => {
    mockManagedMcpProviderStatusData.rows = [managedMcpProviderStatus("supabase")];
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const card = container.querySelector('[data-testid="managed-mcp-provider-supabase"]')!;

    act(() => {
      card.querySelector<HTMLButtonElement>('button[aria-label="Manage Supabase"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    act(() => {
      [...dialog.querySelectorAll("button")]
        .find((button) => button.textContent === "Organization settings")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("explains immediate reductions and next-run increases for an active task", () => {
    mockManagedMcpProviderStatusData.rows = [
      managedMcpProviderStatus("linear", {
        agent: {
          access: "read_only",
          activeRunUsesOlderPolicy: true,
          connection: null,
          effectiveSource: "organization",
          effectiveConnectionId: "linear-connection",
          explicitlyDisabled: false,
        },
      }),
    ];

    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const linearCard = container.querySelector('[data-testid="managed-mcp-provider-linear"]');
    const manageButton = [...linearCard!.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");
    act(() => {
      manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Access reductions apply immediately");
    expect(dialog?.textContent).toContain("increases start with the next run");
  });

  it("saves one coarse access choice with the current binding revision", async () => {
    mockManagedMcpProviderStatusData.rows = [
      managedMcpProviderStatus("linear", {
        agent: {
          access: "read_only",
          activeRunUsesOlderPolicy: false,
          connection: null,
          effectiveSource: "organization",
          effectiveConnectionId: "linear-connection",
          explicitlyDisabled: false,
        },
      }),
    ];
    mockManagedMcpConnectionsData.rows = [
      managedMcpConnection("linear", {
        binding: {
          id: "linear-binding",
          connectionId: "linear-connection",
          agentId: "agent-1",
          status: "active",
          accessMode: "read_only",
          policyRevision: 7,
          enabledToolIds: [],
        },
      }),
    ];
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const linearCard = container.querySelector('[data-testid="managed-mcp-provider-linear"]')!;
    const manageButton = [...linearCard.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");
    act(() => {
      manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const readWrite = [...dialog.querySelectorAll('input[name="agent-provider-access-linear"]')].at(-1);
    act(() => {
      readWrite?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const save = [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Save");
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(agentsApi.updateMcpConnectionBinding).toHaveBeenCalledWith(
      "agent-1",
      "linear-connection",
      {
        accessMode: "read_write",
        status: "active",
        expectedRevision: 7,
      },
      "org-1",
    );
  });

  it("shows read-write but disables it when the organization maximum is read only", () => {
    mockManagedMcpProviderStatusData.rows = [
      managedMcpProviderStatus("supabase", {
        organization: {
          state: "connected",
          connectionId: "supabase-connection",
          maxAccess: "read_only",
          scopeMode: "account",
          revision: 2,
        },
      }),
    ];
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const card = container.querySelector('[data-testid="managed-mcp-provider-supabase"]')!;
    const setAccess = [...card.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");
    act(() => {
      setAccess?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const readWrite = [...dialog.querySelectorAll('input[name="agent-provider-access-supabase"]')].at(-1);

    expect(readWrite?.hasAttribute("disabled")).toBe(true);
    expect(dialog.textContent).toContain("The active connection is read only.");
  });

  it("renders compact built-in summaries without a tool inventory wall", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const manageButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");

    act(() => {
      manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Rudder MCP tools");
    expect(container.textContent).toContain("Rudder Browser");
    expect(container.textContent).toContain("Managed automatically by the Rudder runtime.");
    expect(container.textContent).toContain("No user credential");
    expect(container.textContent).not.toContain("rudder_agent_me");
    expect(container.textContent).not.toContain("rudder_issue_checkout");
    expect(container.textContent).not.toContain("exposed");
    expect(container.textContent).not.toContain("No connected integrations");
    expect(container.textContent).not.toContain("Credential stored");
    expect(container.querySelector('img[src="/rudder-logo.png"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Rudder Browser integration"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Rudder MCP tools integration"]')).toBeTruthy();
    expect(container.textContent).toContain("Built-in2");
  });

  it("shows a disabled Browser built-in with zero exposed tools while core stays available", () => {
    const container = render(<AgentIntegrationsTab
      agent={agent({
        rudderTools: [
          rudderToolSummary(),
          browserToolSummary({ status: "disabled", toolCount: 0, tools: [] }),
        ],
      })}
      orgId="org-1"
    />);
    const manageButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");

    act(() => {
      manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const coreRow = container.querySelector('[aria-label="Rudder MCP tools integration"]');
    const browserRow = container.querySelector('[aria-label="Rudder Browser integration"]');
    expect(coreRow?.textContent).toContain("Available");
    expect(browserRow?.textContent).toContain("Disabled");
    expect(browserRow?.textContent).not.toContain("exposed");
    expect(browserRow?.textContent).not.toContain("rudder_browser_tabs");
  });

  it("uses the larger integration action radius on catalog buttons", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const githubButton = [...container.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Gmail coming soon");

    expect(githubButton?.className).toContain("rounded-[var(--radius-md)]");
  });

  it("opens Feishu setup in a modal from the unified card", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const setupButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Set up"));

    act(() => {
      setupButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("Connect Feishu / Lark");
    expect(dialog?.textContent).toContain("Create a Feishu bot named Wesley - Rudder");
    expect(dialog?.textContent).toContain("opens Feishu with the bot name prefilled");
    expect(dialog?.textContent).toContain("Quick Commands");
    expect(dialog?.textContent).toContain("requests Feishu bot menu and Slash Command permissions");
    expect(dialog?.textContent).toContain("handles /new and /stop messages from");
    expect(dialog?.textContent).toContain("Automatic creation of the Feishu Quick Command menu is not enabled");
    expect(dialog?.textContent).toContain("Feishu CN");
    expect(dialog?.textContent).toContain("Lark Global");
  });

  it("keeps only unavailable providers as disabled coming soon actions", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);

    for (const name of [
      "Gmail",
      "Google Calendar",
      "Google Drive",
      "Notion",
      "GitHub",
      "Linear",
    ]) {
      expect(container.textContent).toContain(name);
    }
    expect(container.textContent).toContain("Read, search, draft, and send email from agent work.");
    expect(container.textContent).toContain("View and edit calendar events for scheduling work.");
    expect(container.textContent).toContain("Browse Drive files and attach workspace context.");
    expect(container.textContent).toContain("Search pages, databases, and operating notes through organization-managed MCP tools.");
    expect(container.textContent).toContain(
      "Search and inspect GitHub repositories through a securely stored personal access token.",
    );
    expect(container.textContent).toContain("Work with the organization’s Linear workspace through managed MCP tools.");
    expect(container.textContent).not.toContain("Feishu Workspace");
    expect(container.textContent?.match(/Coming soon/g)?.length).toBe(3);

    const gmailButton = [...container.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "Gmail coming soon");
    expect(gmailButton).toBeTruthy();
    expect(gmailButton?.hasAttribute("disabled")).toBe(true);
    act(() => {
      gmailButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders a Feishu-safe prefilled bot name for long agent names", () => {
    const container = render(<AgentIntegrationsTab agent={agent({
      name: "ZST613 Bot 1782103161531",
    })} orgId="org-1" />);
    const setupButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Set up"));

    act(() => {
      setupButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Create a Feishu bot named ZST613 Bot 178210316153 - Rudder");
    expect(dialog?.textContent).not.toContain("ZST613 Bot 1782103161531 - Rudde");
  });

  it("shows a reconnect prompt when a previous Feishu integration is revoked", () => {
    const container = render(<AgentIntegrationsTab
      agent={agent({
        integrations: [
          integration({
            status: "revoked",
            revokedAt: new Date("2026-06-18T02:00:00.000Z"),
          }),
        ],
      })}
      orgId="org-1"
    />);
    const setupButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Set up"));

    act(() => {
      setupButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = document.body.querySelector('[role="dialog"]');

    expect(container.textContent).toContain("Disconnected");
    expect(dialog?.textContent).toContain("Reconnect a Feishu bot named Wesley - Rudder");
    expect(dialog?.textContent).toContain("Connect");
    expect(dialog?.textContent).toContain("cli_a_app");
  });

  it("does not list revoked Feishu integrations in manage view", () => {
    const container = render(<AgentIntegrationsTab
      agent={agent({
        integrations: [
          integration({
            status: "revoked",
            revokedAt: new Date("2026-06-18T02:00:00.000Z"),
          }),
        ],
      })}
      orgId="org-1"
    />);
    const manageButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");

    act(() => {
      manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("No connected integrations");
    expect(container.textContent).not.toContain("cli_a_app");
    expect(container.textContent).toContain("Rudder MCP tools");
  });

  it("opens the Feishu setup URL from the agent detail tab", async () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const setupButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Set up"));
    act(() => {
      setupButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    const connectButton = [...dialog!.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Connect"));

    expect(connectButton).toBeTruthy();
    expect(connectButton?.hasAttribute("disabled")).toBe(false);
    act(() => {
      connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(agentsApi.startFeishuSetupSession).toHaveBeenCalledWith("agent-1", {
      providerRegion: "feishu_cn",
    }, "org-1");
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "https://open.feishu.cn/page/launcher?name=Wesley+-+Rudder",
      "_blank",
      "noopener,noreferrer",
    );
    expect(dialog?.textContent).toContain("Waiting for Feishu authorization");
    expect(dialog?.textContent).toContain("Finish setup");
  });

  it("polls the setup session and refreshes agent integration state after Feishu authorization", async () => {
    vi.useFakeTimers();
    vi.mocked(agentsApi.getFeishuSetupSession).mockResolvedValueOnce({
      id: "session-1",
      provider: "feishu",
      providerRegion: "feishu_cn",
      setupUrl: "https://open.feishu.cn/page/launcher?name=Wesley+-+Rudder",
      suggestedBotName: "Wesley - Rudder",
      status: "completed",
      statusDetail: "Connected",
      expiresAt: new Date("2026-06-18T01:10:00.000Z"),
      integration: integration({
        externalAppId: "cli_registered",
        externalBotOpenId: null,
        installerUserId: "ou_installer",
      }),
    });
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const setupButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Set up"));

    act(() => {
      setupButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    const connectButton = [...dialog!.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Connect"));

    await act(async () => {
      connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(agentsApi.getFeishuSetupSession).toHaveBeenCalledWith("agent-1", "session-1", "org-1");
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.agents.integrations("agent-1") });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.agents.detail("agent-1") });
    expect(container.textContent).not.toContain("secret");
  });

  it("updates setup copy when Lark Global is selected", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const setupButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Set up"));
    act(() => {
      setupButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    const regionGroup = dialog?.querySelector('[role="group"][aria-label="Feishu or Lark region"]');
    const feishuButton = [...dialog!.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Feishu CN"));
    const larkButton = [...dialog!.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Lark Global"));

    expect(regionGroup?.className).toContain("rounded-[calc(var(--control-radius)+2px)]");
    expect(feishuButton?.className).toContain("rounded-[var(--control-radius)]");
    expect(larkButton?.className).toContain("rounded-[var(--control-radius)]");
    expect(feishuButton?.getAttribute("aria-pressed")).toBe("true");
    expect(larkButton?.getAttribute("aria-pressed")).toBe("false");
    expect(larkButton).toBeTruthy();
    act(() => {
      larkButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(feishuButton?.getAttribute("aria-pressed")).toBe("false");
    expect(larkButton?.getAttribute("aria-pressed")).toBe("true");
    expect(dialog?.textContent).toContain("Create a Lark bot named Wesley - Rudder");
    expect(dialog?.textContent).toContain("opens Lark with the bot name prefilled");
  });

  it("renders configured Feishu integration metadata and actions in manage view", () => {
    const container = render(<AgentIntegrationsTab agent={agent({ integrations: [integration()] })} orgId="org-1" />);
    const manageButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");

    act(() => {
      manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("1 of 10 connected");
    expect(container.textContent).toContain("cli_a_app");
    expect(container.textContent).toContain("ou_bot");
    expect(container.textContent).toContain("Feishu CN");
    expect(container.textContent).not.toContain("secret-1");
    expect(container.textContent).toContain("Disconnect");
  });

  it("opens the custom API configuration form in a modal with agent-scoped defaults", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const configureButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Configure"));

    act(() => {
      configureButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("Connect Custom API");
    expect(dialog?.textContent).toContain("Choose whether this integration is limited to this agent");
    expect(dialog?.textContent).toContain("This agent");
    expect(dialog?.textContent).toContain("Organization");
    expect(dialog?.textContent).toContain("Base URL");
    expect(dialog?.textContent).toContain("Credential value");
    expect(dialog?.querySelector('input[placeholder="https://api.example.com"]')).toBeTruthy();
    expect(dialog?.querySelector(".md\\:grid-cols-2")).toBeNull();
    expect(dialog?.querySelector('button[aria-label="Connect Custom API"] svg')).toBeNull();
    const scopeControl = [...dialog!.querySelectorAll("div")]
      .find((element) => element.textContent?.trim() === "This agentOrganization");
    const scopeAgentButton = [...dialog!.querySelectorAll("button")]
      .find((button) => button.textContent === "This agent");
    expect(scopeControl?.className).toContain("rounded-[calc(var(--radius-sm)-1px)]");
    expect(scopeAgentButton?.className).toContain("rounded-[2px]");
    expect(scopeAgentButton?.className).toContain("first:rounded-l-[calc(var(--radius-sm)-2px)]");

    const cancelButton = [...dialog!.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Cancel"));
    act(() => {
      cancelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders connected custom integration scope and tool metadata", () => {
    mockCustomIntegrationsData.rows = [customIntegration()];
    const withCustom = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const manageButton = [...withCustom.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");

    act(() => {
      manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(withCustom.textContent).toContain("Linear MCP");
    expect(withCustom.textContent).toContain("This agent only");
    expect(withCustom.textContent).not.toContain("custom.linear-mcp.search_issues");
    expect(withCustom.textContent).toContain("Credential stored");
  });

  it("updates the Feishu daily session notification setting from the manage dialog", async () => {
    const activeIntegration = integration();
    vi.mocked(agentsApi.updateIntegrationSettings).mockResolvedValueOnce(
      integration({
        settings: {
          feishu: {
            dailySessionRolloverEnabled: true,
            dailySessionRolloverHours: 24,
            dailySessionRolloverNotifyFeishu: false,
          },
        },
      }),
    );
    const rendered = render(<AgentIntegrationsTab agent={agent({ integrations: [activeIntegration] })} orgId="org-1" />);
    const configureButton = [...rendered.querySelectorAll("button")]
      .find((button) =>
        button.textContent === "Manage"
        && button.closest(".grid")?.textContent?.includes("Feishu / Lark"));

    act(() => {
      configureButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Notify Feishu when a daily session starts");
    const checkbox = document.body.querySelector('[role="checkbox"]')!;
    act(() => {
      checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(agentsApi.updateIntegrationSettings).toHaveBeenCalledWith("agent-1", "integration-1", {
        settings: {
          feishu: {
            dailySessionRolloverEnabled: true,
            dailySessionRolloverHours: 24,
            dailySessionRolloverNotifyFeishu: false,
          },
        },
      }, "org-1");
    });
  });
});

describe("getFeishuIntegrationState", () => {
  it("maps missing and provider status values to UI states", () => {
    expect(getFeishuIntegrationState(null)).toBe("not_configured");
    expect(getFeishuIntegrationState(integration({ status: "active" }))).toBe("active");
    expect(getFeishuIntegrationState(integration({ status: "revoked" }))).toBe("revoked");
    expect(getFeishuIntegrationState(integration({ status: "error" }))).toBe("error");
  });
});
