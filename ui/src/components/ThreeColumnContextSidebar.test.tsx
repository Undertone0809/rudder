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
  pushToast: vi.fn(),
  setSidebarOpen: vi.fn(),
  pathname: "/RUD/issues",
  search: "",
  relativePath: "/issues",
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
  permissions: { canCreateAgents: true, canAssignTasks: true },
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
  useNavigate: () => vi.fn(),
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
    isMobile: true,
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
    followedIssueIds: [],
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
  mockState.pushToast.mockReset();
  mockState.setSidebarOpen.mockReset();
  mockState.pathname = "/RUD/issues";
  mockState.search = "";
  mockState.relativePath = "/issues";
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
  it("shows the following issues scope in the issues sidebar", () => {
    renderSidebar();

    const followingLink = document.querySelector('a[href="/issues?scope=following"]');
    expect(followingLink?.textContent).toContain("Following");
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
