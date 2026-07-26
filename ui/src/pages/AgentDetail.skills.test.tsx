// @vitest-environment jsdom

import type {
  AgentDetail as AgentDetailRecord,
  AgentSkillEntry,
  AgentSkillSnapshot,
  OrganizationSkillListItem,
} from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "../api/agents";
import { organizationSkillsApi } from "../api/organizationSkills";
import { I18nProvider } from "../context/I18nContext";
import { OrganizationProvider } from "../context/OrganizationContext";
import { AgentDetail } from "./AgentDetail";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api/agents", () => ({
  agentsApi: {
    get: vi.fn(),
    skills: vi.fn(),
    syncSkills: vi.fn(),
  },
}));

vi.mock("../api/organizationSkills", () => ({
  organizationSkillsApi: {
    list: vi.fn(),
  },
}));

vi.mock("../api/health", () => ({
  healthApi: {
    get: vi.fn().mockResolvedValue({ uiLocale: "en" }),
  },
}));

vi.mock("../api/orgs", () => ({
  organizationsApi: {
    list: vi.fn().mockResolvedValue([
      {
        id: "org-1",
        name: "OutcomeProof",
        status: "active",
        issuePrefix: "OUTA",
      },
    ]),
    create: vi.fn(),
  },
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => <div data-testid="mock-markdown-editor" />,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../context/NavigationBackContext", () => ({
  useNavigationBack: () => vi.fn(),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ closePanel: vi.fn() }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

let cleanupFn: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    },
  });
  window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
  vi.mocked(agentsApi.get).mockResolvedValue(agent());
  vi.mocked(agentsApi.skills).mockResolvedValue(skillSnapshot());
  vi.mocked(agentsApi.syncSkills).mockResolvedValue(skillSnapshot());
  vi.mocked(organizationSkillsApi.list).mockResolvedValue(organizationSkills());
});

afterEach(() => {
  act(() => {
    cleanupFn?.();
  });
  cleanupFn = null;
  document.body.innerHTML = "";
  window.localStorage.clear();
  vi.useRealTimers();
});

function renderAgentDetail() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <OrganizationProvider>
            <MemoryRouter initialEntries={["/OUTA/agents/proof-agent/skills"]}>
              <Routes>
                <Route path="/:orgPrefix/agents/:agentId/:tab" element={<AgentDetail />} />
              </Routes>
            </MemoryRouter>
          </OrganizationProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  cleanupFn = () => root?.unmount();
  return container;
}

function agent(): AgentDetailRecord {
  return {
    id: "agent-1",
    orgId: "org-1",
    name: "Proof Agent",
    urlKey: "proof-agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
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
    integrations: [],
  };
}

function skillSnapshot(): AgentSkillSnapshot {
  const entries: AgentSkillEntry[] = Array.from({ length: 44 }, (_, index) => ({
    selectionKey: `global:skill-${index + 1}`,
    key: `skill-${index + 1}`,
    runtimeName: `skill-${index + 1}`,
    description: "External skill description that should stay visible while scrolling.",
    detail: "Discovered in ~/.agents/skills. Enable it here to load it for this agent.",
    desired: false,
    configurable: true,
    alwaysEnabled: false,
    managed: false,
    state: "external",
    sourceClass: "global",
    locationLabel: "~/.agents/skills",
  }));
  return {
    agentRuntimeType: "codex_local",
    supported: true,
    mode: "persistent",
    desiredSkills: [],
    entries,
    warnings: [],
  };
}

function organizationSkills(): OrganizationSkillListItem[] {
  return [{
    id: "org-skill-1",
    orgId: "org-1",
    name: "rudder-docs",
    slug: "rudder-docs",
    key: "rudder/rudder-docs",
    description: "Bundled Rudder skill.",
    sourceType: "local_path",
    sourceLocator: "/workspace/.agents/skills/rudder-docs",
    sourceRef: null,
    trustLevel: "scripts_executables",
    compatibility: "compatible",
    sourceBadge: "rudder",
    sourceLabel: "Bundled by Rudder",
    sourcePath: "/workspace/.agents/skills/rudder-docs/SKILL.md",
    workspaceEditPath: null,
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    attachedAgentCount: 1,
    editable: false,
    editableReason: "Bundled Rudder skills are read-only.",
    createdAt: new Date("2026-06-18T00:00:00.000Z"),
    updatedAt: new Date("2026-06-18T00:00:00.000Z"),
  }];
}

async function flushQueries() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("AgentDetail skills tab", () => {
  it("keeps long external skill lists inside their own scroll region", async () => {
    renderAgentDetail();
    await flushQueries();

    const externalToggle = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("External skills"));
    expect(externalToggle).toBeTruthy();

    act(() => {
      externalToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const scrollRegion = document.querySelector("[data-testid='agent-external-skills-scroll']");
    expect(scrollRegion?.classList.contains("scrollbar-auto-hide")).toBe(true);
    expect(scrollRegion?.classList.contains("overflow-y-auto")).toBe(true);
    expect(scrollRegion?.classList.contains("overscroll-contain")).toBe(true);
    expect(scrollRegion?.className).toContain("max-h-[min(620px,calc(100dvh-16rem))]");
    expect(scrollRegion?.querySelectorAll("[role='switch']")).toHaveLength(44);

    vi.useFakeTimers();
    act(() => {
      scrollRegion?.dispatchEvent(new Event("scroll"));
    });
    expect(scrollRegion?.classList.contains("is-scrolling")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(701);
    });
    expect(scrollRegion?.classList.contains("is-scrolling")).toBe(false);
  });
});
