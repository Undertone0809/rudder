// @vitest-environment jsdom

import { act } from "react";
import type { MouseEventHandler, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_AUTOSAVE_STORAGE_KEY, ISSUE_DRAFTS_STORAGE_KEY } from "@/lib/new-issue-dialog";
import { ThreeColumnContextSidebar } from "./ThreeColumnContextSidebar";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  confirm: vi.fn(),
  openNewIssue: vi.fn(),
  navigate: vi.fn(),
  pushToast: vi.fn(),
  setSidebarOpen: vi.fn(),
  isMobile: true,
  pathname: "/RUD/issues",
  search: "",
  relativePath: "/issues",
  issues: [] as Array<{ id: string; identifier: string; title: string; status: string; projectId?: string | null }>,
  follows: [] as Array<{
    id: string;
    orgId: string;
    issueId: string;
    userId: string;
    createdAt: string;
    issue: { id: string; identifier: string; title: string; status: string };
  }>,
  projects: [] as Array<{ id: string; name: string; archivedAt?: string | null; color?: string | null; urlKey?: string | null }>,
  linearContributions: [] as Array<{
    pluginId: string;
    pluginKey: string;
    displayName: string;
    version: string;
    uiEntryFile: string;
    slots: Array<{ type: string; routePath?: string }>;
    launchers: unknown[];
  }>,
  linearCatalog: null as null | {
    orgId: string;
    projects: Array<{ id: string; name: string; teamIds?: string[] }>;
    teams: Array<{ id: string; name: string }>;
  },
  liveRuns: [] as Array<{
    id: string;
    agentId: string;
    agentName: string;
    agentRuntimeType: string;
    status: string;
    invocationSource: string;
    triggerDetail: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
    issueId?: string | null;
  }>,
}));

const sidebarAgent = {
  id: "agent-1",
  orgId: "org-1",
  name: "Penelope",
  urlKey: "penelope",
  role: "ceo",
  title: "CEO",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  agentRuntimeType: "codex_local",
  agentRuntimeConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: true, canManageSkills: true, canAssignTasks: true },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-04-26T10:00:00.000Z"),
  updatedAt: new Date("2026-04-26T10:00:00.000Z"),
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "auth") {
      return { data: { user: { id: "user-1" } }, isLoading: false, error: null };
    }
    if (queryKey[0] === "agents" && queryKey[1] === "org-1") {
      return { data: [sidebarAgent], isLoading: false, error: null };
    }
    if (queryKey[0] === "projects" && queryKey[1] === "org-1") {
      return { data: mockState.projects, isLoading: false, error: null };
    }
    if (queryKey[0] === "issues" && queryKey[1] === "org-1") {
      return { data: mockState.issues, isLoading: false, error: null };
    }
    if (queryKey[0] === "live-runs" && queryKey[1] === "org-1") {
      return { data: mockState.liveRuns, isLoading: false, error: null };
    }
    if (queryKey[0] === "plugins" && queryKey[1] === "ui-contributions") {
      return { data: mockState.linearContributions, isLoading: false, error: null };
    }
    if (queryKey[0] === "plugins" && queryKey[1] === "rudder.linear") {
      return { data: mockState.linearCatalog, isLoading: false, error: null };
    }
    return { data: [], isLoading: false, error: null };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    onClick,
    ...props
  }: {
    children: ReactNode;
    to: string;
    onClick?: () => void;
  }) => <a href={to} onClick={onClick} {...props}>{children}</a>,
  useLocation: () => ({ pathname: mockState.pathname, search: mockState.search, key: "issues" }),
  useNavigate: () => mockState.navigate,
}));

vi.mock("@/lib/organization-routes", () => ({
  toOrganizationRelativePath: () => mockState.relativePath,
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
  }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: mockState.isMobile,
    setSidebarOpen: mockState.setSidebarOpen,
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({
    pushToast: mockState.pushToast,
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    openNewAgent: vi.fn(),
    openNewIssue: mockState.openNewIssue,
    openNewProject: vi.fn(),
  }),
}));

vi.mock("@/hooks/useIssueFollows", () => ({
  useIssueFollows: () => ({
    follows: mockState.follows,
    followedIssueIds: [],
    isLoading: false,
    error: null,
    toggleFollowIssue: vi.fn(),
  }),
}));

vi.mock("@/components/MessengerContextSidebar", () => ({
  MessengerContextSidebar: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children, ...props }: { children: ReactNode }) => <div {...props}>{children}</div>,
  DropdownMenuItem: ({
    children,
    onContextMenu,
    onSelect,
    ...props
  }: {
    children: ReactNode;
    onContextMenu?: MouseEventHandler<HTMLDivElement>;
    onSelect?: (event: Event) => void;
  }) => (
    <div
      role="button"
      tabIndex={0}
      onClick={(event) => onSelect?.(event.nativeEvent)}
      onContextMenu={onContextMenu}
      {...props}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let cleanupFn: (() => void) | null = null;
let storageState: Record<string, string> = {};

function resetIssueDraftStorage() {
  delete storageState[ISSUE_AUTOSAVE_STORAGE_KEY];
  delete storageState[ISSUE_DRAFTS_STORAGE_KEY];
}

beforeEach(() => {
  storageState = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storageState[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storageState[key] = String(value);
    }),
    removeItem: vi.fn((key: string) => {
      delete storageState[key];
    }),
    clear: vi.fn(() => {
      storageState = {};
    }),
  });
  resetIssueDraftStorage();
  mockState.confirm.mockReset();
  mockState.confirm.mockReturnValue(true);
  mockState.openNewIssue.mockReset();
  mockState.navigate.mockReset();
  mockState.pushToast.mockReset();
  mockState.setSidebarOpen.mockReset();
  mockState.isMobile = true;
  mockState.pathname = "/RUD/issues";
  mockState.search = "";
  mockState.relativePath = "/issues";
  mockState.issues = [];
  mockState.follows = [];
  mockState.projects = [];
  mockState.linearContributions = [];
  mockState.linearCatalog = null;
  mockState.liveRuns = [];
  vi.stubGlobal("confirm", mockState.confirm);
});

afterEach(() => {
  if (cleanupFn) {
    act(() => {
      cleanupFn?.();
    });
  }
  cleanupFn = null;
  resetIssueDraftStorage();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderSidebar() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => root.unmount();

  act(() => {
    root.render(<ThreeColumnContextSidebar />);
  });
}

describe("ThreeColumnContextSidebar issue draft recovery", () => {
  it("uses auto-hidden scrollbars for the issues sidebar main scroll region", () => {
    vi.useFakeTimers();

    renderSidebar();

    const scrollRegion = document.querySelector("[data-testid='issue-sidebar-scroll']") as HTMLDivElement | null;
    expect(scrollRegion).not.toBeNull();
    expect(scrollRegion?.classList.contains("scrollbar-auto-hide")).toBe(true);
    expect(scrollRegion?.classList.contains("overflow-y-auto")).toBe(true);

    act(() => {
      scrollRegion?.dispatchEvent(new Event("scroll"));
    });

    expect(scrollRegion?.classList.contains("is-scrolling")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(701);
    });

    expect(scrollRegion?.classList.contains("is-scrolling")).toBe(false);
  });

  it("uses auto-hidden scrollbars for sibling context sidebar scroll regions", () => {
    mockState.pathname = "/RUD/projects";
    mockState.relativePath = "/projects";
    mockState.projects = [
      { id: "project-1", name: "Launch Prep", archivedAt: null, color: "blue", urlKey: "launch-prep" },
    ];

    renderSidebar();

    expect(document.querySelector("[data-testid='workspace-projects-scroll']")?.classList.contains("scrollbar-auto-hide")).toBe(true);
  });

  it("shows calendar timeline filters with user-facing status labels", () => {
    mockState.pathname = "/RUD/dashboard/calendar";
    mockState.relativePath = "/dashboard/calendar";

    renderSidebar();

    const statusFilters = document.querySelector("[data-testid='calendar-status-filters']");
    expect(document.body.textContent).toContain("Timeline");
    expect(document.body.textContent).not.toContain("Status");
    expect(statusFilters?.textContent).toContain("Planned");
    expect(statusFilters?.textContent).toContain("Running runs");
    expect(statusFilters?.textContent).toContain("Run history");
    expect(statusFilters?.textContent).toContain("External calendar");
    expect(statusFilters?.textContent).toContain("Projected heartbeats");
    expect(statusFilters?.textContent).toContain("Cancelled");
    expect(statusFilters?.textContent).not.toContain("in_progress");
    expect(statusFilters?.textContent).not.toContain("projected");

    const projectedCheckbox = document.querySelector("[aria-label='Show Projected heartbeats events']");
    expect(projectedCheckbox?.getAttribute("data-state")).toBe("unchecked");
    expect(document.querySelector("[aria-label='Show Running runs events']")).not.toBeNull();
    expect(document.querySelector("[aria-label='Show Run history events']")).not.toBeNull();
  });

  it("places the Dashboard and Calendar switcher in the calendar context header", () => {
    mockState.pathname = "/RUD/dashboard/calendar";
    mockState.relativePath = "/dashboard/calendar";

    renderSidebar();

    const header = document.querySelector("[data-testid='workspace-context-header']");
    const switcher = header?.querySelector("[data-testid='dashboard-calendar-switcher']");
    expect(switcher).not.toBeNull();
    expect(switcher?.getAttribute("data-mode")).toBe("calendar");
    expect(header?.textContent).toContain("Dashboard");
    expect(header?.textContent).toContain("Calendar");
    expect(header?.textContent).not.toContain("Sources and filters");
  });

  it("uses agent avatars in calendar agent filters", () => {
    mockState.pathname = "/RUD/dashboard/calendar";
    mockState.relativePath = "/dashboard/calendar";

    renderSidebar();

    const avatar = document.querySelector("[data-testid='calendar-agent-avatar-agent-1']");
    expect(avatar).not.toBeNull();
    expect(avatar?.textContent).not.toContain("Penelope");
    expect(document.body.textContent).toContain("Penelope");
  });

  it("uses auto-hidden scrollbars for chat and agent context sidebars", () => {
    mockState.pathname = "/RUD/chat/chat-1";
    mockState.relativePath = "/chat/chat-1";

    renderSidebar();

    expect(document.querySelector("[data-testid='chat-sidebar-scroll']")?.classList.contains("scrollbar-auto-hide")).toBe(true);

    act(() => {
      cleanupFn?.();
    });
    cleanupFn = null;
    document.body.innerHTML = "";

    mockState.pathname = "/RUD/agents/penelope/dashboard";
    mockState.relativePath = "/agents/penelope/dashboard";

    renderSidebar();

    expect(document.querySelector("[data-testid='agent-sidebar-scroll']")?.classList.contains("scrollbar-auto-hide")).toBe(true);
  });

  it("collapses the desktop workspace sidebar from the context header", () => {
    mockState.isMobile = false;

    renderSidebar();

    const collapseButton = document.querySelector("[aria-label='Collapse workspace sidebar']") as HTMLButtonElement | null;
    expect(collapseButton).not.toBeNull();

    act(() => {
      collapseButton?.click();
    });

    expect(mockState.setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it("shows the following issues scope in the issues sidebar", () => {
    renderSidebar();

    const followingLink = document.querySelector('a[href="/issues?scope=following"]');
    expect(followingLink?.textContent).toContain("Following");
    expect(document.querySelector('a[href="/issues?scope=starred"]')).toBeNull();
  });

  const savedDraft = {
    id: "draft-1",
    orgId: "org-1",
    title: "Recovered draft issue",
    description: "This draft should be findable.",
    status: "backlog",
    priority: "high",
    labelIds: [],
    assigneeValue: "",
    projectId: "",
    projectWorkspaceId: "",
    assigneeModelOverride: "",
    assigneeThinkingEffort: "",
    assigneeChrome: false,
    createdAt: "2026-04-26T10:00:00.000Z",
    updatedAt: "2026-04-26T10:00:00.000Z",
  };

  it("does not show autosave cache as a draft issue", () => {
    window.localStorage.setItem(ISSUE_AUTOSAVE_STORAGE_KEY, JSON.stringify({
      orgId: "org-1",
      title: "Autosaved issue",
      description: "",
      status: "backlog",
      priority: "high",
      labelIds: [],
      assigneeValue: "",
      projectId: "",
      projectWorkspaceId: "",
      assigneeModelOverride: "",
      assigneeThinkingEffort: "",
      assigneeChrome: false,
    }));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => root.unmount();

    act(() => {
      root.render(<ThreeColumnContextSidebar />);
    });

    expect(document.querySelector("[data-testid='issue-draft-sidebar-entry']")).toBeNull();
  });

  it("shows a saved draft issues link in the issues sidebar", () => {
    window.localStorage.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify([savedDraft]));

    renderSidebar();

    const draftEntry = document.querySelector("[data-testid='issue-draft-sidebar-entry']") as HTMLAnchorElement | null;
    expect(draftEntry?.textContent).toContain("Draft Issues (1)");
    expect(draftEntry?.getAttribute("href")).toBe("/issues?scope=drafts");
    expect(draftEntry?.textContent).not.toContain("Recovered draft issue");
  });

  it("shows the saved draft issue count and active state for the draft issues view", () => {
    mockState.search = "?scope=drafts";
    window.localStorage.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify([
      { ...savedDraft, id: "draft-2", title: "Newer draft", updatedAt: "2026-04-26T11:00:00.000Z" },
      savedDraft,
    ]));

    renderSidebar();

    const draftEntry = document.querySelector("[data-testid='issue-draft-sidebar-entry']") as HTMLButtonElement | null;
    expect(draftEntry?.textContent).toContain("Draft Issues (2)");
    expect(draftEntry?.textContent).not.toContain("Newer draft");
    expect(document.querySelector("[data-testid='issue-sidebar-active-indicator']")).not.toBeNull();
  });

  it("renders recently viewed issues as bounded sidebar rows instead of an issue view entry", () => {
    mockState.issues = Array.from({ length: 13 }, (_, index) => ({
      id: `issue-${index + 1}`,
      identifier: `RUD-${index + 1}`,
      title: `Recent issue ${index + 1}`,
      status: "todo",
    }));
    window.localStorage.setItem("rudder:recent-issues:org-1", JSON.stringify(mockState.issues.map((issue) => issue.id)));

    renderSidebar();

    expect(document.querySelector('a[href="/issues?scope=recent"]')).toBeNull();
    expect(document.querySelector("[data-testid='issue-recent-section']")?.textContent).toContain("Recently Viewed (13)");
    expect(document.querySelector("[data-testid='issue-recent-row-issue-1']")?.textContent).toContain("Recent issue 1");
    expect(document.querySelector("[data-testid='issue-recent-row-issue-5']")?.textContent).toContain("Recent issue 5");
    expect(document.querySelector("[data-testid='issue-recent-row-issue-6']")).toBeNull();

    const toggle = document.querySelector("[data-testid='issue-recent-toggle']") as HTMLButtonElement | null;
    expect(toggle?.textContent).toContain("Show all");

    act(() => {
      toggle?.click();
    });

    expect(document.querySelector("[data-testid='issue-recent-row-issue-12']")?.textContent).toContain("Recent issue 12");
    expect(document.querySelector("[data-testid='issue-recent-row-issue-13']")?.textContent).toContain("Recent issue 13");
    expect(document.body.textContent).not.toContain("Showing latest");
    expect(toggle?.textContent).toContain("Show less");
  });

  it("keeps the expanded recent list scroll-bounded while showing every resolved recent issue", () => {
    mockState.issues = Array.from({ length: 12 }, (_, index) => ({
      id: `issue-${index + 1}`,
      identifier: `RUD-${index + 1}`,
      title: `Recent issue ${index + 1}`,
      status: "todo",
    }));
    window.localStorage.setItem("rudder:recent-issues:org-1", JSON.stringify(mockState.issues.map((issue) => issue.id)));

    renderSidebar();

    const toggle = document.querySelector("[data-testid='issue-recent-toggle']") as HTMLButtonElement | null;
    act(() => {
      toggle?.click();
    });

    const recentList = document.querySelector("[data-testid='issue-recent-list']") as HTMLDivElement | null;
    expect(recentList?.className).toContain("max-h-72");
    expect(recentList?.className).toContain("scrollbar-auto-hide");
    expect(recentList?.className).toContain("overflow-y-auto");
    expect(document.querySelector("[data-testid='issue-recent-row-issue-12']")?.textContent).toContain("Recent issue 12");
    expect(document.body.textContent).not.toContain("Showing latest");
  });

  it("moves a clicked recent sidebar issue to the front of recent history", () => {
    mockState.issues = Array.from({ length: 3 }, (_, index) => ({
      id: `issue-${index + 1}`,
      identifier: `RUD-${index + 1}`,
      title: `Recent issue ${index + 1}`,
      status: "todo",
    }));
    window.localStorage.setItem("rudder:recent-issues:org-1", JSON.stringify(["issue-1", "issue-2", "issue-3"]));

    renderSidebar();

    const secondRecent = document.querySelector("[data-testid='issue-recent-row-issue-2']") as HTMLAnchorElement | null;
    act(() => {
      secondRecent?.click();
    });

    expect(JSON.parse(window.localStorage.getItem("rudder:recent-issues:org-1") ?? "[]")).toEqual([
      "issue-2",
      "issue-1",
      "issue-3",
    ]);
    expect(mockState.setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it("marks the active issue detail in the recently viewed sidebar list", () => {
    mockState.pathname = "/RUD/issues/RUD-2";
    mockState.relativePath = "/issues/RUD-2";
    mockState.issues = [
      { id: "issue-1", identifier: "RUD-1", title: "Recent issue 1", status: "todo" },
      { id: "issue-2", identifier: "RUD-2", title: "Recent issue 2", status: "todo" },
    ];
    window.localStorage.setItem("rudder:recent-issues:org-1", JSON.stringify(["issue-1", "issue-2"]));

    renderSidebar();

    const activeRow = document.querySelector("[data-testid='issue-recent-row-issue-2']") as HTMLAnchorElement | null;
    expect(activeRow?.getAttribute("aria-current")).toBe("page");
  });

  it("renders starred issues as bounded sidebar rows after issues are starred", () => {
    mockState.issues = Array.from({ length: 7 }, (_, index) => ({
      id: `issue-${index + 1}`,
      identifier: `RUD-${index + 1}`,
      title: `Starred issue ${index + 1}`,
      status: "todo",
    }));
    mockState.follows = mockState.issues.map((issue, index) => ({
      id: `follow-${index + 1}`,
      orgId: "org-1",
      issueId: issue.id,
      userId: "user-1",
      createdAt: `2026-04-26T10:${String(index).padStart(2, "0")}:00.000Z`,
      issue,
    }));

    renderSidebar();

    expect(document.querySelector('a[href="/issues?scope=starred"]')).toBeNull();
    expect(document.querySelector("[data-testid='issue-starred-section']")?.textContent).toContain("Starred (7)");
    expect(document.querySelector("[data-testid='issue-starred-row-issue-1']")?.textContent).toContain("Starred issue 1");
    expect(document.querySelector("[data-testid='issue-starred-row-issue-5']")?.textContent).toContain("Starred issue 5");
    expect(document.querySelector("[data-testid='issue-starred-row-issue-6']")).toBeNull();

    const toggle = document.querySelector("[data-testid='issue-starred-toggle']") as HTMLButtonElement | null;
    expect(toggle?.textContent).toContain("Show all");

    act(() => {
      toggle?.click();
    });

    expect(document.querySelector("[data-testid='issue-starred-row-issue-7']")?.textContent).toContain("Starred issue 7");
    const starredList = document.querySelector("[data-testid='issue-starred-list']") as HTMLDivElement | null;
    expect(starredList?.className).toContain("max-h-72");
    expect(starredList?.className).toContain("scrollbar-auto-hide");
    expect(toggle?.textContent).toContain("Show less");
  });

  it("marks the active issue detail in the starred sidebar list", () => {
    mockState.pathname = "/RUD/issues/RUD-2";
    mockState.relativePath = "/issues/RUD-2";
    const starredIssue = { id: "issue-2", identifier: "RUD-2", title: "Starred active issue", status: "todo" };
    mockState.issues = [starredIssue];
    mockState.follows = [{
      id: "follow-1",
      orgId: "org-1",
      issueId: starredIssue.id,
      userId: "user-1",
      createdAt: "2026-04-26T10:00:00.000Z",
      issue: starredIssue,
    }];

    renderSidebar();

    const activeRow = document.querySelector("[data-testid='issue-starred-row-issue-2']") as HTMLAnchorElement | null;
    expect(activeRow?.getAttribute("aria-current")).toBe("page");
  });

  it("ignores previously stored custom boards in the issues sidebar", () => {
    window.localStorage.setItem("rudder:issue-custom-views:org-1", JSON.stringify([
      {
        id: "view-1",
        orgId: "org-1",
        name: "Review board",
        state: {
          statuses: ["in_review"],
          priorities: [],
          assignees: [],
          labels: [],
          projects: [],
          displayProperties: ["identifier", "assignee"],
          sortField: "updated",
          sortDir: "desc",
          groupBy: "none",
          viewMode: "board",
          collapsedGroups: [],
        },
        createdAt: "2026-04-30T01:00:00.000Z",
        updatedAt: "2026-04-30T01:00:00.000Z",
      },
    ]));

    renderSidebar();

    const section = document.querySelector("[data-testid='issue-custom-views-section']");
    expect(section).toBeNull();
    const row = document.querySelector<HTMLAnchorElement>("[data-testid='issue-custom-view-row-view-1'] a");
    expect(row).toBeNull();
  });

  it("shows connected Linear teams in the issues sidebar when Linear has no projects", () => {
    mockState.linearContributions = [{
      pluginId: "plugin-linear",
      pluginKey: "rudder.linear",
      displayName: "Linear",
      version: "0.1.0",
      uiEntryFile: "index.js",
      slots: [{ type: "page", routePath: "linear" }],
      launchers: [],
    }];
    mockState.linearCatalog = {
      orgId: "org-1",
      projects: [],
      teams: [
        { id: "team-zeeland", name: "Zeeland" },
        { id: "team-rudder", name: "Rudder" },
      ],
    };

    renderSidebar();

    const section = document.querySelector("[data-testid='issue-linear-section']");
    expect(section?.textContent).toContain("Linear");
    expect(section?.textContent).not.toContain("External");
    expect(document.querySelector("[data-testid='issue-linear-section-toggle']")).not.toBeNull();

    const teamLink = document.querySelector<HTMLAnchorElement>("[data-testid='issue-linear-team-team-rudder']");
    expect(teamLink?.textContent).toContain("Rudder");
    expect(teamLink?.getAttribute("href")).toBe("/issues?source=linear&linearTeamId=team-rudder");
  });

  it("marks a Linear team slice active on the issue source board", () => {
    mockState.pathname = "/RUD/issues";
    mockState.relativePath = "/issues";
    mockState.search = "?source=linear&linearTeamId=team-rudder";
    mockState.linearContributions = [{
      pluginId: "plugin-linear",
      pluginKey: "rudder.linear",
      displayName: "Linear",
      version: "0.1.0",
      uiEntryFile: "index.js",
      slots: [{ type: "page", routePath: "linear" }],
      launchers: [],
    }];
    mockState.linearCatalog = {
      orgId: "org-1",
      projects: [],
      teams: [{ id: "team-rudder", name: "Rudder" }],
    };

    renderSidebar();

    const activeLink = document.querySelector<HTMLAnchorElement>("[data-testid='issue-linear-team-team-rudder']");
    expect(activeLink?.getAttribute("aria-current")).toBe("page");
    expect(activeLink?.className).toContain("bg-[color:color-mix");
    expect(document.querySelector("[data-testid='issue-linear-sidebar-active-indicator']")).toBeNull();
  });

  it("shows Linear projects under their connected team and routes them into the issue board", () => {
    mockState.linearContributions = [{
      pluginId: "plugin-linear",
      pluginKey: "rudder.linear",
      displayName: "Linear",
      version: "0.1.0",
      uiEntryFile: "index.js",
      slots: [{ type: "page", routePath: "linear" }],
      launchers: [],
    }];
    mockState.linearCatalog = {
      orgId: "org-1",
      projects: [{ id: "project-roadmap", name: "Roadmap", teamIds: ["team-rudder"] }],
      teams: [{ id: "team-rudder", name: "Rudder" }],
    };

    renderSidebar();

    const projectLink = document.querySelector<HTMLAnchorElement>("[data-testid='issue-linear-project-project-roadmap']");
    expect(projectLink?.textContent).toContain("Roadmap");
    expect(projectLink?.getAttribute("href")).toBe("/issues?source=linear&linearTeamId=team-rudder&linearProjectId=project-roadmap");
  });

  it("shows live run counts on issue project rows", () => {
    mockState.projects = [
      { id: "project-1", name: "Launch Prep", color: "blue", archivedAt: null, urlKey: "launch-prep" },
      { id: "project-2", name: "Platform", color: "green", archivedAt: null, urlKey: "platform" },
    ];
    mockState.issues = [
      { id: "issue-1", identifier: "RUD-1", title: "First issue", status: "todo", projectId: "project-1" },
      { id: "issue-2", identifier: "RUD-2", title: "Second issue", status: "in_progress", projectId: "project-1" },
      { id: "issue-3", identifier: "RUD-3", title: "Third issue", status: "todo", projectId: "project-2" },
    ];
    mockState.liveRuns = [
      {
        id: "run-1",
        agentId: "agent-1",
        agentName: "Penelope",
        agentRuntimeType: "codex_local",
        status: "running",
        invocationSource: "manual",
        triggerDetail: "Manual wakeup",
        startedAt: "2026-04-30T10:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-30T10:00:00.000Z",
        issueId: "issue-1",
      },
      {
        id: "run-2",
        agentId: "agent-1",
        agentName: "Penelope",
        agentRuntimeType: "codex_local",
        status: "running",
        invocationSource: "manual",
        triggerDetail: "Manual wakeup",
        startedAt: "2026-04-30T10:05:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-30T10:05:00.000Z",
        issueId: "issue-2",
      },
    ];

    renderSidebar();

    expect(document.querySelector("[data-testid='issue-project-row-project-1']")?.textContent).toContain("2 live");
    expect(document.querySelector("[data-testid='issue-project-row-project-2']")?.textContent).not.toContain("live");
  });

});

describe("ThreeColumnContextSidebar agent actions", () => {
  it("shows the agent row action menu in the agent detail sidebar", () => {
    mockState.pathname = "/RUD/agents/penelope/dashboard";
    mockState.relativePath = "/agents/penelope/dashboard";

    renderSidebar();

    const row = document.querySelector("[data-testid='agent-sidebar-row-agent-1']") as HTMLElement | null;
    expect(row?.textContent).toContain("Penelope (CEO)");

    const actions = document.querySelector("[data-testid='agent-sidebar-actions-agent-1']") as HTMLButtonElement | null;
    expect(actions?.getAttribute("aria-label")).toBe("More actions for Penelope");
    expect(document.body.textContent).toContain("Create task");
    expect(document.body.textContent).toContain("Chat with agent");
    expect(document.body.textContent).toContain("Run heartbeat");
    expect(document.body.textContent).toContain("Pause agent");
    expect(document.body.textContent).toContain("Copy agent name");
  });
});
