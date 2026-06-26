// @vitest-environment jsdom

import type { AgentDetail, AgentIntegrationSummary } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { AgentIntegrationsTab, getFeishuIntegrationState } from "./AgentDetail.integrations";

const mockWindowOpen = vi.fn();

const mockInvalidateQueries = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ initialData }: { initialData?: unknown }) => ({
    data: initialData,
    isLoading: false,
  }),
  useMutation: (options: { mutationFn?: () => Promise<unknown>; onSuccess?: (result: unknown) => void | Promise<void> }) => ({
    mutate: vi.fn(async () => {
      const result = await options.mutationFn?.();
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
    integrations: [],
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
    installedAt: new Date("2026-06-18T01:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-06-18T01:00:00.000Z"),
    updatedAt: new Date("2026-06-18T01:00:00.000Z"),
    ...overrides,
  };
}

describe("AgentIntegrationsTab", () => {
  it("renders a stable Feishu row when the agent has no integration", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);

    expect(container.textContent).toContain("Integrations");
    expect(container.textContent).toContain("Feishu / Lark");
    expect(container.textContent).toContain("Not configured");
    expect(container.textContent).toContain("Connect");
    expect(container.textContent).toContain("Create a Feishu bot named Wesley - Rudder");
    expect(container.textContent).toContain("opens Feishu with the bot name prefilled");
    expect(container.textContent).toContain("Quick Commands");
    expect(container.textContent).toContain("requests Feishu bot menu and Slash Command permissions");
    expect(container.textContent).toContain("handles /new and /stop messages from");
    expect(container.textContent).toContain("Automatic creation of the Feishu Quick Command menu is not enabled");
    expect(container.textContent).toContain("Feishu CN");
    expect(container.textContent).toContain("Lark Global");
  });

  it("renders a Feishu-safe prefilled bot name for long agent names", () => {
    const container = render(<AgentIntegrationsTab agent={agent({
      name: "ZST613 Bot 1782103161531",
    })} orgId="org-1" />);

    expect(container.textContent).toContain("Create a Feishu bot named ZST613 Bot 178210316153 - Rudder");
    expect(container.textContent).not.toContain("ZST613 Bot 1782103161531 - Rudde");
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

    expect(container.textContent).toContain("Disconnected");
    expect(container.textContent).toContain("Reconnect a Feishu bot named Wesley - Rudder");
    expect(container.textContent).toContain("Connect");
    expect(container.textContent).toContain("cli_a_app");
  });

  it("opens the Feishu setup URL from the agent detail tab", async () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const connectButton = [...container.querySelectorAll("button")]
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
    expect(container.textContent).toContain("Waiting for Feishu authorization");
    expect(container.textContent).toContain("Finish setup");
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
    const connectButton = [...container.querySelectorAll("button")]
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
    const larkButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Lark Global"));

    expect(larkButton).toBeTruthy();
    act(() => {
      larkButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Create a Lark bot named Wesley - Rudder");
    expect(container.textContent).toContain("opens Lark with the bot name prefilled");
  });

  it("renders configured Feishu integration metadata and actions", () => {
    const container = render(<AgentIntegrationsTab agent={agent({ integrations: [integration()] })} orgId="org-1" />);

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("cli_a_app");
    expect(container.textContent).toContain("ou_bot");
    expect(container.textContent).toContain("Feishu CN");
    expect(container.textContent).toContain("Credential stored");
    expect(container.textContent).toContain("Quick Commands");
    expect(container.textContent).toContain("requests Feishu bot menu and Slash Command permissions");
    expect(container.textContent).toContain("handles /new and /stop messages from");
    expect(container.textContent).toContain("Automatic creation of the Feishu Quick Command menu is not enabled");
    expect(container.textContent).not.toContain("secret-1");
    expect(container.textContent).toContain("Disconnect");
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
