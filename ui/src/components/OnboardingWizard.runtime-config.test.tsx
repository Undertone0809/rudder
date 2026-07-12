// @vitest-environment jsdom

import { agentsApi } from "@/api/agents";
import { secretsApi } from "@/api/secrets";
import type { Organization } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.fn();
const closeOnboardingMock = vi.fn();
const setSelectedOrganizationIdMock = vi.fn();

const existingOrganization: Organization = {
  id: "org-1",
  name: "Acme",
  urlKey: "acme",
  issuePrefix: "ACM",
  issueCounter: 1,
  status: "active",
  pauseReason: null,
  pausedAt: null,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  requireBoardApprovalForNewAgents: false,
  defaultChatIssueCreationMode: "manual_approval",
  workspace: null,
  description: null,
  brandColor: null,
  logoAssetId: null,
  logoUrl: null,
  createdAt: new Date("2026-06-18T00:00:00.000Z"),
  updatedAt: new Date("2026-06-18T00:00:00.000Z"),
};

vi.mock("@/api/agents", () => ({
  agentsApi: {
    adapterModels: vi.fn(),
    suggestName: vi.fn(),
    testEnvironment: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/api/secrets", () => ({
  secretsApi: {
    create: vi.fn(),
  },
}));

vi.mock("@codesandbox/sandpack-react", () => ({}));

vi.mock("../agent-runtimes", () => ({
  getUIAdapter: (agentRuntimeType: string) => ({
    label: agentRuntimeType === "pi_local" ? "Pi" : agentRuntimeType,
    buildAdapterConfig: (values: {
      model?: string;
      command?: string;
      args?: string;
      url?: string;
      dangerouslySkipPermissions?: boolean;
      permissionMode?: string;
      envBindings?: Record<string, unknown>;
    }) => {
      const config: Record<string, unknown> = {};
      if (values.model) config.model = values.model;
      if (values.command) config.command = values.command;
      if (values.args) config.args = values.args;
      if (values.url) config.url = values.url;
      if (typeof values.dangerouslySkipPermissions === "boolean") {
        config.dangerouslySkipPermissions = values.dangerouslySkipPermissions;
      }
      if (values.permissionMode) config.permissionMode = values.permissionMode;
      if (values.envBindings && Object.keys(values.envBindings).length > 0) {
        config.env = values.envBindings;
      }
      return config;
    },
  }),
}));

vi.mock("@/api/orgs", () => ({
  organizationsApi: {
    get: vi.fn(async () => existingOrganization),
    remove: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/api/goals", () => ({ goalsApi: { create: vi.fn(), update: vi.fn() } }));
vi.mock("@/api/issues", () => ({ issuesApi: { create: vi.fn() } }));
vi.mock("@/api/onboarding", () => ({ onboardingApi: { seedGettingStarted: vi.fn() } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: vi.fn(), create: vi.fn() } }));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    onboardingOpen: true,
    onboardingOptions: { initialStep: 2, orgId: "org-1" },
    closeOnboarding: closeOnboardingMock,
  }),
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({
    organizations: [existingOrganization],
    setSelectedOrganizationId: setSelectedOrganizationIdMock,
    loading: false,
  }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/messenger" }),
  useNavigate: () => navigateMock,
  useParams: () => ({}),
}));

vi.mock("./AsciiArtAnimation", () => ({
  AsciiArtAnimation: () => <div data-testid="ascii-art-animation" />,
}));

vi.mock("./ProductTourOverlay", () => ({
  markProductTourPending: vi.fn(),
}));

let cleanupFn: (() => void) | null = null;

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function render(element: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  cleanupFn = () => {
    act(() => root.unmount());
    host.remove();
    queryClient.clear();
  };

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        {element}
      </QueryClientProvider>,
    );
    await flush();
  });

  return host;
}

function inputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function findButton(surface: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(surface.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.includes(text));
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

describe("OnboardingWizard runtime config", () => {
  beforeEach(() => {
    const originalInsertRule = CSSStyleSheet.prototype.insertRule;
    vi.spyOn(CSSStyleSheet.prototype, "insertRule").mockImplementation(function insertRule(
      this: CSSStyleSheet,
      rule: string,
      index?: number,
    ) {
      if (rule.startsWith("--sxs")) {
        return originalInsertRule.call(this, `:root{${rule}}`, index);
      }
      return originalInsertRule.call(this, rule, index);
    });
    vi.mocked(agentsApi.adapterModels).mockResolvedValue([
      { id: "kimi-coding/kimi-for-coding", label: "Kimi for Coding" },
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
    ]);
    vi.mocked(agentsApi.suggestName).mockResolvedValue({ name: "DeepSeek Agent" });
    vi.mocked(agentsApi.testEnvironment).mockResolvedValue({
      agentRuntimeType: "pi_local",
      status: "pass",
      testedAt: "2026-06-18T00:00:00.000Z",
      checks: [{ code: "pi_hello_probe_passed", level: "info", message: "Pi hello probe succeeded." }],
    });
    vi.mocked(secretsApi.create).mockResolvedValue({
      id: "secret-1",
      orgId: "org-1",
      name: "onboarding-deepseek-api-key",
      provider: "local_encrypted",
      externalRef: null,
      latestVersion: 1,
      description: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    });
    vi.mocked(agentsApi.create).mockResolvedValue({
      id: "agent-1",
      orgId: "org-1",
      name: "DeepSeek Agent",
      urlKey: "deepseek-agent",
      role: "ceo",
      title: "Founder Agent",
      icon: null,
      status: "active",
      reportsTo: null,
      capabilities: null,
      agentRuntimeType: "pi_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: true, canManageSkills: true },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    });
  });

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = null;
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("defaults Codex onboarding to GPT-5.6-sol", async () => {
    const { OnboardingWizard } = await import("./OnboardingWizard");
    await render(<OnboardingWizard />);
    const surface = document.body;

    await vi.waitFor(() => {
      expect(surface.textContent).toContain("Create your first agent");
    });
    expect(surface.textContent).not.toContain("Task");
    expect(surface.textContent).not.toContain("Launch");

    await act(async () => {
      click(findButton(surface, "Codex"));
      await flush();
    });

    expect(findButton(surface, "GPT-5.6-sol")).toBeTruthy();
  });

  it("creates the default Claude agent with auto permission mode instead of dangerous bypass", async () => {
    vi.mocked(agentsApi.testEnvironment).mockResolvedValue({
      agentRuntimeType: "claude_local",
      status: "pass",
      testedAt: "2026-06-18T00:00:00.000Z",
      checks: [{ code: "claude_hello_probe_passed", level: "info", message: "Claude hello probe succeeded." }],
    });

    const { OnboardingWizard } = await import("./OnboardingWizard");
    await render(<OnboardingWizard />);
    const surface = document.body;

    await vi.waitFor(() => {
      expect(surface.textContent).toContain("Create your first agent");
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(surface.querySelector<HTMLInputElement>("input[placeholder='Agent name']")?.value)
          .toBe("DeepSeek Agent");
      });
    });

    await act(async () => {
      click(findButton(surface, "Create"));
      await flush();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(agentsApi.create).toHaveBeenCalledWith("org-1", expect.objectContaining({
          agentRuntimeType: "claude_local",
          agentRuntimeConfig: expect.objectContaining({
            dangerouslySkipPermissions: false,
            permissionMode: "auto",
          }),
        }));
      });
    });

    expect(agentsApi.testEnvironment).toHaveBeenCalledWith("org-1", "claude_local", {
      agentRuntimeConfig: expect.objectContaining({
        dangerouslySkipPermissions: false,
        permissionMode: "auto",
      }),
    });
  }, 15_000);

  it("stores a Pi DeepSeek onboarding key as a secret ref in Test now and created agent config", async () => {
    const { OnboardingWizard } = await import("./OnboardingWizard");
    await render(<OnboardingWizard />);
    const surface = document.body;

    await vi.waitFor(() => {
      expect(surface.textContent).toContain("Create your first agent");
    });

    await act(async () => {
      click(findButton(surface, "More Agent Runtime Types"));
      await flush();
    });

    await act(async () => {
      click(findButton(surface, "Pi"));
      await flush();
    });

    await vi.waitFor(() => {
      expect(agentsApi.adapterModels).toHaveBeenCalledWith("org-1", "pi_local");
    });

    await act(async () => {
      click(findButton(surface, "kimi-for-coding"));
      await flush();
    });

    const modelSearch = document.querySelector<HTMLInputElement>(
      "input[placeholder='Search or enter provider/model...']",
    );
    expect(modelSearch).toBeTruthy();

    await act(async () => {
      inputValue(modelSearch!, "deepseek/deepseek-chat");
      await flush();
    });

    const deepSeekModelOption = Array.from(document.querySelectorAll("span[title='deepseek/deepseek-chat']"))
      .map((span) => span.closest("button"))
      .find(Boolean);
    expect(deepSeekModelOption).toBeTruthy();

    await act(async () => {
      click(deepSeekModelOption!);
      await flush();
    });

    const keyInput = await vi.waitFor(() => {
      const input = surface.querySelector<HTMLInputElement>("input[placeholder='Paste DEEPSEEK_API_KEY']");
      expect(input).toBeTruthy();
      return input!;
    });

    await act(async () => {
      inputValue(keyInput, "test-deepseek-key");
      await flush();
    });

    await act(async () => {
      click(findButton(surface, "Test now"));
      await flush();
    });

    await vi.waitFor(() => {
      expect(agentsApi.testEnvironment).toHaveBeenCalledWith("org-1", "pi_local", {
        agentRuntimeConfig: expect.objectContaining({
          model: "deepseek/deepseek-chat",
          env: {
            DEEPSEEK_API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        }),
      });
    });

    await act(async () => {
      click(findButton(surface, "Create"));
      await flush();
    });

    await vi.waitFor(() => {
      expect(agentsApi.create).toHaveBeenCalledWith("org-1", expect.objectContaining({
        agentRuntimeType: "pi_local",
        agentRuntimeConfig: expect.objectContaining({
          model: "deepseek/deepseek-chat",
          env: {
            DEEPSEEK_API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        }),
      }));
    });

    expect(secretsApi.create).toHaveBeenCalledTimes(1);
    expect(secretsApi.create).toHaveBeenCalledWith("org-1", expect.objectContaining({
      value: "test-deepseek-key",
    }));
    const createdPayload = vi.mocked(agentsApi.create).mock.calls[0]?.[1];
    expect(JSON.stringify(createdPayload)).not.toContain("test-deepseek-key");
  }, 15_000);
});
