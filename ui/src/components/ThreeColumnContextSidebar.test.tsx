// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_DRAFT_STORAGE_KEY } from "@/lib/new-issue-dialog";
import { ThreeColumnContextSidebar } from "./ThreeColumnContextSidebar";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
  setSidebarOpen: vi.fn(),
  pathname: "/RUD/issues",
  search: "",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "auth") {
      return { data: { user: { id: "user-1" } }, isLoading: false, error: null };
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
  toOrganizationRelativePath: () => "/issues",
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
    pushToast: vi.fn(),
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

let cleanupFn: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  mockState.openNewIssue.mockReset();
  mockState.setSidebarOpen.mockReset();
});

afterEach(() => {
  if (cleanupFn) {
    act(() => {
      cleanupFn?.();
    });
  }
  cleanupFn = null;
  window.localStorage.clear();
  document.body.innerHTML = "";
});

describe("ThreeColumnContextSidebar issue draft recovery", () => {
  it("shows a saved issue draft in the issues sidebar and opens the new issue dialog", () => {
    window.localStorage.setItem(ISSUE_DRAFT_STORAGE_KEY, JSON.stringify({
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
      executionWorkspaceMode: "shared_workspace",
      selectedExecutionWorkspaceId: "",
    }));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => root.unmount();

    act(() => {
      root.render(<ThreeColumnContextSidebar />);
    });

    const draftEntry = document.querySelector("[data-testid='issue-draft-sidebar-entry']") as HTMLButtonElement | null;
    expect(draftEntry?.textContent).toContain("Draft Issue");
    expect(draftEntry?.textContent).toContain("Recovered draft issue");

    act(() => {
      draftEntry?.click();
    });

    expect(mockState.openNewIssue).toHaveBeenCalledTimes(1);
    expect(mockState.setSidebarOpen).toHaveBeenCalledWith(false);
  });
});
