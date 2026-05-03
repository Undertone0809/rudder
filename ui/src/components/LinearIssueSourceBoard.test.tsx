// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearIssueSourceBoard } from "./LinearIssueSourceBoard";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  pushToast: vi.fn(),
  listUiContributions: vi.fn(),
  bridgeGetData: vi.fn(),
  bridgePerformAction: vi.fn(),
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    listUiContributions: mockState.listUiContributions,
    bridgeGetData: mockState.bridgeGetData,
    bridgePerformAction: mockState.bridgePerformAction,
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({
    pushToast: mockState.pushToast,
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

let cleanupFn: (() => void) | null = null;

const linearContribution = {
  pluginId: "plugin-linear",
  pluginKey: "rudder.linear",
  displayName: "Linear",
  version: "0.1.0",
  uiEntryFile: "index.js",
  slots: [{ type: "page", routePath: "linear" }],
  launchers: [],
};

const catalog = {
  orgId: "org-1",
  teams: [{
    id: "team-eng",
    key: "ENG",
    name: "Engineering",
    states: [
      { id: "state-backlog", name: "Backlog", type: "backlog" },
      { id: "state-progress", name: "In Progress", type: "started" },
    ],
  }],
  projects: [{ id: "linear-roadmap", name: "Roadmap", teamIds: ["team-eng"] }],
  users: [{ id: "user-amy", name: "Amy" }],
};

const issueRow = {
  id: "lin-2",
  identifier: "ENG-102",
  title: "Status mapped issue",
  description: "External issue",
  url: "https://linear.app/example/issue/ENG-102",
  updatedAt: "2026-04-21T08:30:00.000Z",
  createdAt: "2026-04-11T09:00:00.000Z",
  team: catalog.teams[0]!,
  state: catalog.teams[0]!.states[1]!,
  project: catalog.projects[0]!,
  assignee: catalog.users[0]!,
  imported: false,
  importedRudderIssueId: null,
  importedRudderIssueIdentifier: null,
  importedOrgId: null,
};

function installLocalStorageMock() {
  const storageState: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storageState[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storageState[key] = String(value);
    }),
    removeItem: vi.fn((key: string) => {
      delete storageState[key];
    }),
    clear: vi.fn(() => {
      for (const key of Object.keys(storageState)) delete storageState[key];
    }),
  });
}

async function renderBoard() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => root.unmount();

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <LinearIssueSourceBoard
          orgId="org-1"
          orgName="Rudder QA"
          projects={[{ id: "rudder-project", name: "Rudder Project", archivedAt: null }]}
          linearTeamId="team-eng"
          linearProjectId="linear-roadmap"
        />
      </QueryClientProvider>,
    );
  });
  await flushAsyncWork();
}

async function flushAsyncWork() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  installLocalStorageMock();
  mockState.pushToast.mockReset();
  mockState.listUiContributions.mockReset();
  mockState.bridgeGetData.mockReset();
  mockState.bridgePerformAction.mockReset();
  mockState.listUiContributions.mockResolvedValue([linearContribution]);
  mockState.bridgeGetData.mockImplementation(async (_pluginId: string, key: string) => {
    if (key === "page-bootstrap") {
      return {
        data: {
          configured: true,
          message: null,
          projects: [{ id: "rudder-project", name: "Rudder Project" }],
          teamMappings: [{
            teamId: "team-eng",
            teamName: "Engineering",
            stateMappings: [{ linearStateId: "state-progress", linearStateName: "In Progress", rudderStatus: "in_progress" }],
          }],
        },
      };
    }
    if (key === "linear-catalog") return { data: catalog };
    if (key === "linear-issues") {
      return {
        data: {
          rows: [issueRow],
          endCursor: null,
          hasNextPage: false,
          totalShown: 1,
        },
      };
    }
    return { data: null };
  });
  mockState.bridgePerformAction.mockResolvedValue({
    data: {
      importedCount: 1,
      duplicateCount: 0,
      fallbackCount: 0,
      adjustedCount: 0,
    },
  });
});

afterEach(() => {
  if (cleanupFn) {
    act(() => {
      cleanupFn?.();
    });
  }
  cleanupFn = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("LinearIssueSourceBoard", () => {
  it("groups Linear issues into mapped Rudder status lanes without native drag controls", async () => {
    await renderBoard();

    expect(document.querySelector("[data-testid='linear-source-board']")?.textContent).toContain("Roadmap");
    expect(document.querySelector("[data-testid='linear-source-kanban-column-in_progress']")?.textContent).toContain("ENG-102");
    expect(document.querySelector("[data-testid='linear-source-hidden-columns']")?.textContent).toContain("Done");
    expect(document.querySelector("[data-testid='linear-source-board-card-lin-2']")?.textContent).not.toContain("Import");
  });

  it("imports selected Linear issues after choosing a project in the import dialog", async () => {
    await renderBoard();

    const listToggle = document.querySelector<HTMLButtonElement>("[data-testid='linear-source-view-list']");
    act(() => {
      listToggle?.click();
    });

    const checkbox = document.querySelector<HTMLInputElement>("[data-testid='linear-source-row-checkbox-lin-2']");
    act(() => {
      checkbox?.click();
    });

    const importButton = document.querySelector<HTMLButtonElement>("[data-testid='linear-source-import-selected']");
    await act(async () => {
      importButton?.click();
    });
    await flushAsyncWork();

    expect(document.body.textContent).toContain("Project in Rudder QA");
    const target = document.querySelector<HTMLSelectElement>("[data-testid='linear-source-import-project']");
    act(() => {
      if (!target) return;
      target.value = "rudder-project";
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const confirmButton = document.querySelector<HTMLButtonElement>("[data-testid='linear-source-confirm-import']");
    await act(async () => {
      confirmButton?.click();
    });
    await flushAsyncWork();

    expect(mockState.bridgePerformAction).toHaveBeenCalledWith(
      "plugin-linear",
      "import-linear-issues",
      expect.objectContaining({
        orgId: "org-1",
        targetProjectId: "rudder-project",
        mode: "selected",
        issueIds: ["lin-2"],
        filters: expect.objectContaining({
          teamId: "team-eng",
          projectId: "linear-roadmap",
        }),
      }),
      "org-1",
    );
    expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Linear import complete",
      tone: "success",
    }));
  });
});
