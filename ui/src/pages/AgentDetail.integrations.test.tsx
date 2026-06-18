// @vitest-environment jsdom

import type { AgentDetail, AgentIntegrationSummary } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentIntegrationsTab, getFeishuIntegrationState } from "./AgentDetail.integrations";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ initialData }: { initialData?: unknown }) => ({
    data: initialData,
    isLoading: false,
  }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: vi.fn(),
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
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
  });

  it("opens a Feishu connection form from the agent detail tab", () => {
    const container = render(<AgentIntegrationsTab agent={agent()} orgId="org-1" />);
    const connectButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Connect"));

    expect(connectButton).toBeTruthy();
    expect(connectButton?.hasAttribute("disabled")).toBe(false);
    act(() => {
      connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Credential secret ID");
    expect(container.textContent).toContain("App ID");
    expect(container.textContent).toContain("Bot open ID");
    expect(container.querySelector("select")?.textContent).toContain("Lark Global");
  });

  it("renders configured Feishu integration metadata and actions", () => {
    const container = render(<AgentIntegrationsTab agent={agent({ integrations: [integration()] })} orgId="org-1" />);

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("cli_a_app");
    expect(container.textContent).toContain("ou_bot");
    expect(container.textContent).toContain("Feishu CN");
    expect(container.textContent).toContain("Credential stored");
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
