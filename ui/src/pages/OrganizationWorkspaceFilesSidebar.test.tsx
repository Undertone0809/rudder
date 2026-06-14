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

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ locale: "en", t: (key: string) => key }),
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

function openEntryOpenSubmenu(entryPath: string) {
  const trigger = document.querySelector<HTMLElement>(
    `[data-testid="org-workspaces-entry-open-submenu-${entryPath}"]`,
  );
  expect(trigger).toBeTruthy();
  act(() => {
    trigger?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    trigger?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("OrganizationWorkspaceFilesSidebar", () => {
  it("renders a workspace launcher in the sidebar header", async () => {
    const listWorkspaceLaunchTargets = vi.fn().mockResolvedValue([
      { id: "vscode", label: "VS Code", kind: "ide" },
    ]);
    mockState.desktopShell = {
      listWorkspaceLaunchTargets,
      openWorkspace: vi.fn(),
    };

    renderSidebar();
    await act(async () => {
      await Promise.resolve();
    });

    const header = document.querySelector("[data-testid='workspace-context-header']");
    expect(header?.getAttribute("aria-label")).toBe("Library");
    expect(header?.querySelector("h2")).toBeNull();
    expect(document.querySelector("[data-testid='org-workspaces-sidebar-launcher']")).not.toBeNull();
    expect(listWorkspaceLaunchTargets).toHaveBeenCalledTimes(1);
  });

  it("offers installed IDE choices from the file Open in editor submenu", async () => {
    const openWorkspace = vi.fn(async () => undefined);
    const openWorkspaceFileInIde = vi.fn(async () => undefined);
    mockState.desktopShell = {
      listWorkspaceLaunchTargets: vi.fn().mockResolvedValue([
        { id: "cursor", label: "Cursor", kind: "ide" },
        { id: "vscode", label: "VS Code", kind: "ide" },
        { id: "commandPrompt", label: "Command Prompt", kind: "terminal" },
        { id: "powershell", label: "PowerShell", kind: "terminal" },
        { id: "finder", label: "Folder", kind: "folder" },
      ]),
      openWorkspace,
      openWorkspaceFileInIde,
    };

    renderSidebar("docs/draft.md");
    await act(async () => {
      await Promise.resolve();
    });

    openEntryMenu("docs/draft.md");
    openEntryOpenSubmenu("docs/draft.md");

    expect(document.querySelector("[data-testid='org-workspaces-entry-open-target-docs/draft.md-cursor']")).not.toBeNull();
    expect(document.querySelector("[data-testid='org-workspaces-entry-open-target-docs/draft.md-vscode']")).not.toBeNull();
    expect(document.querySelector("[data-testid='org-workspaces-entry-open-target-docs/draft.md-commandPrompt']")).toBeNull();
    expect(document.querySelector("[data-testid='org-workspaces-entry-open-target-docs/draft.md-powershell']")).toBeNull();
    expect(document.querySelector("[data-testid='org-workspaces-entry-open-target-docs/draft.md-finder']")).toBeNull();

    const vscodeItem = document.querySelector<HTMLElement>(
      "[data-testid='org-workspaces-entry-open-target-docs/draft.md-vscode']",
    );
    await act(async () => {
      vscodeItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(openWorkspaceFileInIde).toHaveBeenCalledWith("/tmp/rudder-org", "docs/draft.md", "vscode");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("offers installed app choices from the directory Open folder submenu", async () => {
    const openWorkspace = vi.fn(async () => undefined);
    const openWorkspaceFileInIde = vi.fn(async () => undefined);
    mockState.desktopShell = {
      listWorkspaceLaunchTargets: vi.fn().mockResolvedValue([
        { id: "vscode", label: "VS Code", kind: "ide" },
        { id: "commandPrompt", label: "Command Prompt", kind: "terminal" },
        { id: "powershell", label: "PowerShell", kind: "terminal" },
        { id: "finder", label: "Folder", kind: "folder" },
      ]),
      openWorkspace,
      openWorkspaceFileInIde,
    };

    renderSidebar("docs/draft.md");
    await act(async () => {
      await Promise.resolve();
    });

    openEntryMenu("docs");
    openEntryOpenSubmenu("docs");

    expect(document.querySelector("[data-testid='org-workspaces-entry-open-target-docs-vscode']")).not.toBeNull();
    expect(document.querySelector("[data-testid='org-workspaces-entry-open-target-docs-commandPrompt']")).not.toBeNull();
    expect(document.querySelector("[data-testid='org-workspaces-entry-open-target-docs-powershell']")).not.toBeNull();
    expect(document.querySelector("[data-testid='org-workspaces-entry-open-target-docs-finder']")).not.toBeNull();

    const finderItem = document.querySelector<HTMLElement>(
      "[data-testid='org-workspaces-entry-open-target-docs-finder']",
    );
    await act(async () => {
      finderItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(openWorkspace).toHaveBeenCalledWith("/tmp/rudder-org/docs", "finder");
    expect(openWorkspaceFileInIde).not.toHaveBeenCalled();
  });

  it("hides destructive actions for protected agent instruction entries", () => {
    renderSidebar();

    const instructionsMenu = openEntryMenu("agents/Asher/instructions");
    expect(instructionsMenu?.textContent).toContain("Copy link");
    expect(instructionsMenu?.textContent).toContain("Copy absolute path");
    expect(instructionsMenu?.textContent).toContain("New file");
    expect(instructionsMenu?.textContent).not.toContain("Delete");
    expect(instructionsMenu?.textContent).not.toContain("Rename");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const heartbeatMenu = openEntryMenu("agents/Asher/instructions/HEARTBEAT.md");
    expect(heartbeatMenu?.textContent).toContain("Copy link");
    expect(heartbeatMenu?.textContent).toContain("Copy absolute path");
    expect(heartbeatMenu?.textContent).not.toContain("Delete");
    expect(heartbeatMenu?.textContent).not.toContain("Rename");
  });

  it("copies distinct Library links and absolute paths from the entry menu", async () => {
    const copyText = vi.fn(async () => undefined);
    mockState.desktopShell = { copyText };

    renderSidebar();

    openEntryMenu("agents/Asher/instructions/HEARTBEAT.md");
    const copyLinkItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((item) => item.textContent?.includes("Copy link"));
    expect(copyLinkItem).toBeTruthy();
    await act(async () => {
      copyLinkItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(copyText).toHaveBeenLastCalledWith(
      "[HEARTBEAT.md](library-file://file?p=agents%2FAsher%2Finstructions%2FHEARTBEAT.md)",
    );
    expect(mockState.pushToast).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Library link copied",
    }));

    openEntryMenu("agents/Asher/instructions/HEARTBEAT.md");
    const copyAbsolutePathItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((item) => item.textContent?.includes("Copy absolute path"));
    expect(copyAbsolutePathItem).toBeTruthy();
    await act(async () => {
      copyAbsolutePathItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(copyText).toHaveBeenLastCalledWith("/tmp/rudder-org/agents/Asher/instructions/HEARTBEAT.md");
    expect(mockState.pushToast).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Absolute path copied",
    }));
  });

  it("copies directory Library links with the directory query", async () => {
    const copyText = vi.fn(async () => undefined);
    mockState.desktopShell = { copyText };

    renderSidebar();

    openEntryMenu("agents/Asher/instructions");
    const copyLinkItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((item) => item.textContent?.includes("Copy link"));
    expect(copyLinkItem).toBeTruthy();
    await act(async () => {
      copyLinkItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(copyText).toHaveBeenLastCalledWith(
      "[instructions](/library?directory=agents%2FAsher%2Finstructions)",
    );
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
    expect(memoryFolderMenu?.textContent).toContain("Copy link");
    expect(memoryFolderMenu?.textContent).toContain("Copy absolute path");
    expect(memoryFolderMenu?.textContent).toContain("New file");
    expect(memoryFolderMenu?.textContent).not.toContain("Delete");
    expect(memoryFolderMenu?.textContent).not.toContain("Rename");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const memoryFileMenu = openEntryMenu("agents/Asher/memory/notes.md");
    expect(memoryFileMenu?.textContent).toContain("Copy link");
    expect(memoryFileMenu?.textContent).toContain("Copy absolute path");
    expect(memoryFileMenu?.textContent).not.toContain("Delete");
    expect(memoryFileMenu?.textContent).not.toContain("Rename");
  });

  it("hides destructive actions for agent skill entries", () => {
    renderSidebar("agents/Asher/skills/agent-helper/SKILL.md");

    const agentSkillsFolderMenu = openEntryMenu("agents/Asher/skills");
    expect(agentSkillsFolderMenu?.textContent).toContain("Copy link");
    expect(agentSkillsFolderMenu?.textContent).toContain("Copy absolute path");
    expect(agentSkillsFolderMenu?.textContent).toContain("New file");
    expect(agentSkillsFolderMenu?.textContent).not.toContain("Delete");
    expect(agentSkillsFolderMenu?.textContent).not.toContain("Rename");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const agentSkillFileMenu = openEntryMenu("agents/Asher/skills/agent-helper/SKILL.md");
    expect(agentSkillFileMenu?.textContent).toContain("Copy link");
    expect(agentSkillFileMenu?.textContent).toContain("Copy absolute path");
    expect(agentSkillFileMenu?.textContent).not.toContain("Delete");
    expect(agentSkillFileMenu?.textContent).not.toContain("Rename");
  });

  it("hides destructive actions for organization skill entries", () => {
    renderSidebar("skills/org-helper/SKILL.md");

    const skillsRootMenu = openEntryMenu("skills");
    expect(skillsRootMenu?.textContent).toContain("Copy link");
    expect(skillsRootMenu?.textContent).toContain("Copy absolute path");
    expect(skillsRootMenu?.textContent).toContain("New file");
    expect(skillsRootMenu?.textContent).not.toContain("Delete");
    expect(skillsRootMenu?.textContent).not.toContain("Rename");

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const orgSkillFileMenu = openEntryMenu("skills/org-helper/SKILL.md");
    expect(orgSkillFileMenu?.textContent).toContain("Copy link");
    expect(orgSkillFileMenu?.textContent).toContain("Copy absolute path");
    expect(orgSkillFileMenu?.textContent).not.toContain("Delete");
    expect(orgSkillFileMenu?.textContent).not.toContain("Rename");
  });
});
