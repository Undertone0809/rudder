// @vitest-environment jsdom

import {
  RUDDER_AGENT_V1_MCP_SERVER_NAME,
  RUDDER_AGENT_V1_MCP_TOOL_NAMES,
  type AgentDetail,
  type AgentIntegrationSummary,
  type AgentOperatingLayerIntegrationSummary,
  type CustomIntegrationSummary,
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
const mockCustomIntegrationsData = vi.hoisted(() => ({
  rows: [] as CustomIntegrationSummary[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ initialData, queryKey }: { initialData?: unknown; queryKey?: readonly unknown[] }) => ({
    data: queryKey?.includes("custom-integrations") ? mockCustomIntegrationsData.rows : initialData,
    isLoading: false,
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
  },
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
    reportsTo: null,
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
    chainOfCommand: [],
    access: { membership: null, grants: [], canAssignTasks: false, taskAssignSource: "none" },
    instructionsLibraryPath: null,
    operatingLayerIntegrations: [operatingLayerIntegration()],
    integrations: [],
    ...overrides,
  };
}

function operatingLayerIntegration(overrides: Partial<AgentOperatingLayerIntegrationSummary> = {}): AgentOperatingLayerIntegrationSummary {
  return {
    id: RUDDER_AGENT_V1_MCP_SERVER_NAME,
    displayName: "Rudder MCP tools",
    kind: "rudder_mcp",
    status: "available",
    scope: "runtime",
    serverName: RUDDER_AGENT_V1_MCP_SERVER_NAME,
    contract: "agent-v1",
    toolCount: RUDDER_AGENT_V1_MCP_TOOL_NAMES.length,
    tools: [...RUDDER_AGENT_V1_MCP_TOOL_NAMES],
    authMode: "runtime_managed",
    cliFallbackAvailable: true,
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

describe("AgentIntegrationsTab", () => {
  it("renders a stable Feishu row when the agent has no integration", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);

    expect(container.textContent).not.toContain("Connect the external tools this agent can use during work loops.");
    expect(container.textContent).toContain("Discover");
    expect(container.textContent).toContain("Manage");
    expect(container.textContent).not.toContain("Built-in");
    expect(container.textContent).not.toContain("Rudder MCP tools");
    expect(container.textContent).not.toContain("rudder-operating-layer");
    expect(container.textContent).not.toContain("runtime-managed auth");
    expect(container.textContent).toContain("Custom API");
    expect(container.textContent).toContain("MCP Server");
    expect(container.textContent).toContain("Feishu / Lark");
    expect(container.textContent).toContain("Not configured");
    expect(container.textContent).toContain("Set up");
    expect(container.textContent?.match(/Coming soon/g)?.length).toBe(6);
    expect(container.textContent).not.toContain("0 of 10 connected");
    expect(container.textContent).not.toContain("Create a Feishu bot named Wesley - Rudder");
  });

  it("renders built-in Rudder MCP tools in manage view without custom integration actions", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const manageButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Manage");

    act(() => {
      manageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Rudder MCP tools");
    expect(container.textContent).toContain("rudder-operating-layer");
    expect(container.textContent).toContain(`${RUDDER_AGENT_V1_MCP_TOOL_NAMES.length} exposed`);
    expect(container.textContent).toContain("Runtime managed");
    expect(container.textContent).toContain("No user credential");
    expect(container.textContent).toContain("rudder_agent_me");
    expect(container.textContent).toContain("rudder_issue_checkout");
    expect(container.textContent).not.toContain("No connected integrations");
    expect(container.textContent).not.toContain("Credential stored");
    expect(container.querySelector('img[src="/rudder-logo.png"]')).toBeTruthy();
  });

  it("uses the larger integration action radius on catalog buttons", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const githubButton = [...container.querySelectorAll("button")]
      .find((button) => button.getAttribute("aria-label") === "GitHub coming soon");

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

  it("renders planned agent tool integrations as disabled coming soon actions", () => {
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
    expect(container.textContent).toContain("Search pages, databases, and operating notes.");
    expect(container.textContent).toContain("Clone and inspect repositories during agent runs.");
    expect(container.textContent).toContain("Link delivery issues and sync engineering work state.");
    expect(container.textContent).not.toContain("Feishu Workspace");
    expect(container.textContent?.match(/Coming soon/g)?.length).toBe(6);

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
    const larkButton = [...dialog!.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Lark Global"));

    expect(larkButton).toBeTruthy();
    act(() => {
      larkButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

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
    expect(withCustom.textContent).toContain("custom.linear-mcp.search_issues");
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
    const manageButtons = [...rendered.querySelectorAll("button")]
      .filter((button) => button.textContent === "Manage");
    const configureButton = manageButtons.at(-1);

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
