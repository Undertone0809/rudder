// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationWorkspaceFilesSidebar } from "./OrganizationWorkspaces";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  pushToast: vi.fn(),
  setSearchParams: vi.fn(),
  searchParams: "path=agents/Asher/instructions/HEARTBEAT.md",
  desktopShell: null as unknown,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(({ queryKey }) => {
    const key = queryKey as string[];
    if (key[2] === "workspace-files") {
      const directoryPath = key[3] ?? "";
      const entriesByDirectory: Record<string, Array<{
        name: string;
        displayLabel?: string;
        path: string;
        isDirectory: boolean;
        entityType?: "agent_workspace" | "organization_workspace";
      }>> = {
        "": [
          {
            name: "agents",
            displayLabel: "agents",
            path: "agents",
            isDirectory: true,
            entityType: "organization_workspace",
          },
          {
            name: "docs",
            displayLabel: "docs",
            path: "docs",
            isDirectory: true,
            entityType: "organization_workspace",
          },
          {
            name: "skills",
            displayLabel: "skills",
            path: "skills",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        agents: [
          {
            name: "Asher",
            displayLabel: "Asher",
            path: "agents/Asher",
            isDirectory: true,
            entityType: "agent_workspace",
          },
        ],
        "agents/Asher": [
          {
            name: "instructions",
            displayLabel: "instructions",
            path: "agents/Asher/instructions",
            isDirectory: true,
            entityType: "organization_workspace",
          },
          {
            name: "memory",
            displayLabel: "memory",
            path: "agents/Asher/memory",
            isDirectory: true,
            entityType: "organization_workspace",
          },
          {
            name: "skills",
            displayLabel: "skills",
            path: "agents/Asher/skills",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        "agents/Asher/instructions": [
          {
            name: "HEARTBEAT.md",
            displayLabel: "HEARTBEAT.md",
            path: "agents/Asher/instructions/HEARTBEAT.md",
            isDirectory: false,
            entityType: "organization_workspace",
          },
          {
            name: "notes.md",
            displayLabel: "notes.md",
            path: "agents/Asher/instructions/notes.md",
            isDirectory: false,
            entityType: "organization_workspace",
          },
        ],
        "agents/Asher/memory": [
          {
            name: "notes.md",
            displayLabel: "notes.md",
            path: "agents/Asher/memory/notes.md",
            isDirectory: false,
            entityType: "organization_workspace",
          },
        ],
        "agents/Asher/skills": [
          {
            name: "agent-helper",
            displayLabel: "agent-helper",
            path: "agents/Asher/skills/agent-helper",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        "agents/Asher/skills/agent-helper": [
          {
            name: "SKILL.md",
            displayLabel: "SKILL.md",
            path: "agents/Asher/skills/agent-helper/SKILL.md",
            isDirectory: false,
            entityType: "organization_workspace",
          },
        ],
        docs: [
          {
            name: "draft.md",
            displayLabel: "draft.md",
            path: "docs/draft.md",
            isDirectory: false,
            entityType: "organization_workspace",
          },
        ],
        skills: [
          {
            name: "org-helper",
            displayLabel: "org-helper",
            path: "skills/org-helper",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        "skills/org-helper": [
          {
            name: "SKILL.md",
            displayLabel: "SKILL.md",
            path: "skills/org-helper/SKILL.md",
            isDirectory: false,
            entityType: "organization_workspace",
          },
        ],
      };
      return {
        data: {
          rootExists: true,
          rootPath: "/tmp/rudder-org",
          directoryPath,
          entries: entriesByDirectory[directoryPath] ?? [],
        },
        isLoading: false,
        error: null,
      };
    }
    return { data: null, isLoading: false, error: null };
  }),
  useMutation: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  })),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  })),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [
    new URLSearchParams(mockState.searchParams),
    mockState.setSearchParams,
  ],
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: mockState.pushToast,
  }),
}));

vi.mock("../hooks/useViewedOrganization", () => ({
  useViewedOrganization: () => ({
    viewedOrganizationId: "org-1",
    viewedOrganization: {
      id: "org-1",
      name: "Rudder",
      issuePrefix: "RUD",
    },
  }),
}));

vi.mock("../lib/desktop-shell", () => ({
  readDesktopShell: () => mockState.desktopShell,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value?: string }) => (
    <textarea aria-label="Markdown editor" readOnly value={value ?? ""} />
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: import("react").ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
}));

let cleanupFn: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    },
  });
  mockState.desktopShell = null;
  mockState.searchParams = "path=agents/Asher/instructions/HEARTBEAT.md";
});

afterEach(() => {
  act(() => {
    cleanupFn?.();
  });
  cleanupFn = null;
  document.body.innerHTML = "";
});

function renderSidebar(activePath?: string) {
  if (activePath) {
    mockState.searchParams = `path=${encodeURIComponent(activePath)}`;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(<OrganizationWorkspaceFilesSidebar />);
  });
  cleanupFn = () => root?.unmount();
}

function openEntryMenu(entryPath: string) {
  const trigger = document.querySelector(
    `[data-testid="org-workspaces-entry-more-${entryPath}"]`,
  ) as HTMLButtonElement | null;
  expect(trigger).toBeTruthy();
  act(() => {
    trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const menu = document.querySelector("[data-slot='dropdown-menu-content'], [role='menu']");
  expect(menu).toBeTruthy();
  return menu;
}

describe("OrganizationWorkspaceFilesSidebar", () => {
  it("does not render a workspace launcher in the sidebar header", () => {
    const listWorkspaceLaunchTargets = vi.fn().mockResolvedValue([
      { id: "vscode", label: "VS Code", kind: "ide" },
    ]);
    mockState.desktopShell = {
      listWorkspaceLaunchTargets,
      openWorkspace: vi.fn(),
    };

    renderSidebar();

    expect(document.querySelector("[data-testid='workspace-context-header']")?.textContent).toContain("Library");
    expect(document.querySelector("[data-testid='org-workspaces-launcher']")).toBeNull();
    expect(listWorkspaceLaunchTargets).not.toHaveBeenCalled();
  });

  it("hides destructive actions for protected agent instruction entries", () => {
    renderSidebar();

    const instructionsMenu = openEntryMenu("agents/Asher/instructions");
    expect(instructionsMenu?.textContent).toContain("Copy file path");
    expect(instructionsMenu?.textContent).toContain("New file");
    expect(instructionsMenu?.textContent).not.toContain("Delete");
    expect(instructionsMenu?.textContent).not.toContain("Rename");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const heartbeatMenu = openEntryMenu("agents/Asher/instructions/HEARTBEAT.md");
    expect(heartbeatMenu?.textContent).toContain("Copy file path");
    expect(heartbeatMenu?.textContent).not.toContain("Delete");
    expect(heartbeatMenu?.textContent).not.toContain("Rename");
  });

  it("keeps delete available for ordinary workspace files", () => {
    mockState.setSearchParams.mockReturnValue(undefined);

    renderSidebar();

    const menu = openEntryMenu("agents/Asher/instructions/notes.md");
    expect(menu?.textContent).toContain("Rename");
    expect(menu?.textContent).toContain("Delete");
  });

  it("hides destructive actions for agent memory entries", () => {
    renderSidebar("agents/Asher/memory/notes.md");

    const memoryFolderMenu = openEntryMenu("agents/Asher/memory");
    expect(memoryFolderMenu?.textContent).toContain("Copy file path");
    expect(memoryFolderMenu?.textContent).toContain("New file");
    expect(memoryFolderMenu?.textContent).not.toContain("Delete");
    expect(memoryFolderMenu?.textContent).not.toContain("Rename");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const memoryFileMenu = openEntryMenu("agents/Asher/memory/notes.md");
    expect(memoryFileMenu?.textContent).toContain("Copy file path");
    expect(memoryFileMenu?.textContent).not.toContain("Delete");
    expect(memoryFileMenu?.textContent).not.toContain("Rename");
  });

  it("hides destructive actions for agent skill entries", () => {
    renderSidebar("agents/Asher/skills/agent-helper/SKILL.md");

    const agentSkillsFolderMenu = openEntryMenu("agents/Asher/skills");
    expect(agentSkillsFolderMenu?.textContent).toContain("Copy file path");
    expect(agentSkillsFolderMenu?.textContent).toContain("New file");
    expect(agentSkillsFolderMenu?.textContent).not.toContain("Delete");
    expect(agentSkillsFolderMenu?.textContent).not.toContain("Rename");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const agentSkillFileMenu = openEntryMenu("agents/Asher/skills/agent-helper/SKILL.md");
    expect(agentSkillFileMenu?.textContent).toContain("Copy file path");
    expect(agentSkillFileMenu?.textContent).not.toContain("Delete");
    expect(agentSkillFileMenu?.textContent).not.toContain("Rename");
  });

  it("hides destructive actions for organization skill entries", () => {
    renderSidebar("skills/org-helper/SKILL.md");

    const skillsRootMenu = openEntryMenu("skills");
    expect(skillsRootMenu?.textContent).toContain("Copy file path");
    expect(skillsRootMenu?.textContent).toContain("New file");
    expect(skillsRootMenu?.textContent).not.toContain("Delete");
    expect(skillsRootMenu?.textContent).not.toContain("Rename");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const orgSkillFileMenu = openEntryMenu("skills/org-helper/SKILL.md");
    expect(orgSkillFileMenu?.textContent).toContain("Copy file path");
    expect(orgSkillFileMenu?.textContent).not.toContain("Delete");
    expect(orgSkillFileMenu?.textContent).not.toContain("Rename");
  });
});
