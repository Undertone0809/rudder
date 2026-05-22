// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_DRAFTS_STORAGE_KEY } from "@/lib/new-issue-dialog";
import { ThemeProvider } from "@/context/ThemeContext";
import { Issues } from "./Issues";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  agents: [
    { id: "agent-1", name: "Build Agent" },
  ],
  confirm: vi.fn(),
  openNewIssue: vi.fn(),
  projects: [
    { id: "project-1", name: "Rudder App" },
  ],
  pushToast: vi.fn(),
  search: "?scope=drafts",
  session: { user: { id: "local-board" } },
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "agents") return { data: mockState.agents, isLoading: false, error: null };
    if (queryKey[0] === "projects") return { data: mockState.projects, isLoading: false, error: null };
    if (queryKey[0] === "auth") return { data: mockState.session, isLoading: false, error: null };
    return { data: [], isLoading: false, error: null };
  },
  useMutation: () => ({
    mutate: vi.fn(),
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/RUD/issues", search: mockState.search, hash: "", key: "issues" }),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(mockState.search)],
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockState.setBreadcrumbs,
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: mockState.openNewIssue,
    confirm: mockState.confirm,
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({
    pushToast: mockState.pushToast,
  }),
}));

vi.mock("@/hooks/useIssueFollows", () => ({
  useIssueFollows: () => ({
    followedIssueIds: new Set<string>(),
    toggleFollowIssue: vi.fn(),
  }),
}));

vi.mock("@/components/IssuesList", () => ({
  IssuesList: () => <div data-testid="issues-list">Issues list</div>,
}));

let cleanupFn: (() => void) | null = null;
let storageState: Record<string, string> = {};

const savedDraft = {
  id: "draft-1",
  orgId: "org-1",
  title: "Recovered draft issue",
  description: "This draft should be shown in main content.",
  status: "backlog",
  priority: "high",
  labelIds: [],
  assigneeValue: "agent:agent-1",
  projectId: "project-1",
  projectWorkspaceId: "",
  assigneeModelOverride: "",
  assigneeThinkingEffort: "",
  assigneeChrome: false,
  executionWorkspaceMode: "shared_workspace",
  selectedExecutionWorkspaceId: "",
  createdAt: "2026-04-26T10:00:00.000Z",
  updatedAt: "2026-04-26T10:00:00.000Z",
};

function installLocalStorageMock() {
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
}

function renderIssues() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => root.unmount();

  act(() => {
    root.render(
      <ThemeProvider>
        <Issues />
      </ThemeProvider>,
    );
  });
}

beforeEach(() => {
  installLocalStorageMock();
  window.localStorage.clear();
  mockState.confirm.mockReset();
  mockState.confirm.mockReturnValue(true);
  mockState.openNewIssue.mockReset();
  mockState.pushToast.mockReset();
  mockState.search = "?scope=drafts";
  vi.stubGlobal("confirm", mockState.confirm);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
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
  vi.unstubAllGlobals();
});

describe("Issues draft scope", () => {
  it("renders saved draft issues in the main content and opens a selected draft", () => {
    window.localStorage.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify([
      { ...savedDraft, id: "draft-2", title: "Newer draft", updatedAt: "2026-04-26T11:00:00.000Z" },
      savedDraft,
    ]));

    renderIssues();

    expect(document.querySelector("[data-testid='issue-drafts-view']")?.textContent).toContain("Draft Issues");
    const cards = Array.from(document.querySelectorAll("[data-testid='issue-draft-card']"));
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("Newer draft");
    expect(cards[1]?.textContent).toContain("Recovered draft issue");
    expect(cards[1]?.textContent).toContain("Rudder App");
    expect(cards[1]?.textContent).toContain("Build Agent");

    const openButton = cards[1]?.querySelector("button") as HTMLButtonElement | null;
    act(() => {
      openButton?.click();
    });

    expect(mockState.openNewIssue).toHaveBeenCalledWith({ draftId: "draft-1" });
  });

  it("renders draft priority with the shared bar glyph and label", () => {
    window.localStorage.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify([
      { ...savedDraft, priority: "critical" },
    ]));

    renderIssues();

    const card = document.querySelector("[data-testid='issue-draft-card']");
    expect(card?.textContent).toContain("Urgent");
    expect(card?.textContent).not.toContain("Critical");
    expect(card?.querySelector('[data-slot="priority-bars-icon"]')?.children).toHaveLength(4);
  });

  it("renders markdown and images in the constrained draft card preview", () => {
    window.localStorage.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify([
      {
        ...savedDraft,
        description: "## Screenshot\n![](/api/assets/draft-image/content)\n- **Looks** better",
      },
    ]));

    renderIssues();

    const preview = document.querySelector("[data-testid='issue-draft-description-preview']");
    expect(preview?.className).toContain("max-h-[4.5rem]");
    expect(preview?.textContent).toContain("Screenshot");
    expect(preview?.querySelector("strong")?.textContent).toBe("Looks");
    expect(preview?.querySelector("img")?.getAttribute("src")).toBe("/api/assets/draft-image/content");
  });

  it("deletes a draft issue from the main content after confirmation", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify([savedDraft]));

    try {
      renderIssues();

      const deleteButton = document.querySelector(
        "[data-testid='issue-draft-delete-button']",
      ) as HTMLButtonElement | null;
      await act(async () => {
        deleteButton?.click();
      });

      expect(mockState.confirm).toHaveBeenCalledWith({
        title: 'Delete draft issue "Recovered draft issue"?',
        description: "This cannot be undone.",
        confirmLabel: "Delete",
        tone: "destructive",
      });
      const deletingCard = document.querySelector("[data-testid='issue-draft-card']") as HTMLElement | null;
      const openButton = document.querySelector(
        "[aria-label='Open draft Recovered draft issue']",
      ) as HTMLButtonElement | null;
      expect(deletingCard?.getAttribute("data-deleting")).toBe("true");
      expect(deleteButton?.disabled).toBe(true);
      expect(openButton?.disabled).toBe(true);
      expect(mockState.pushToast).not.toHaveBeenCalled();
      const storedDraftIds = (JSON.parse(
        window.localStorage.getItem(ISSUE_DRAFTS_STORAGE_KEY) ?? "[]",
      ) as Array<{ id: string }>).map((draft) => draft.id);
      expect(storedDraftIds).toEqual(["draft-1"]);

      await act(async () => {
        vi.advanceTimersByTime(250);
      });

      expect(mockState.pushToast).toHaveBeenCalledWith({ title: "Draft issue deleted", tone: "success" });
      expect(JSON.parse(window.localStorage.getItem(ISSUE_DRAFTS_STORAGE_KEY) ?? "[]")).toEqual([]);
      expect(document.querySelector("[data-testid='issue-draft-card']")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a confirmed draft immediately for reduced-motion users", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    window.localStorage.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify([savedDraft]));

    renderIssues();

    const deleteButton = document.querySelector(
      "[data-testid='issue-draft-delete-button']",
    ) as HTMLButtonElement | null;
    await act(async () => {
      deleteButton?.click();
    });

    expect(mockState.pushToast).toHaveBeenCalledWith({ title: "Draft issue deleted", tone: "success" });
    expect(JSON.parse(window.localStorage.getItem(ISSUE_DRAFTS_STORAGE_KEY) ?? "[]")).toEqual([]);
    expect(document.querySelector("[data-testid='issue-draft-card']")).toBeNull();
  });

  it("keeps a draft issue when deletion is cancelled", async () => {
    mockState.confirm.mockReturnValue(false);
    window.localStorage.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify([savedDraft]));

    renderIssues();

    const deleteButton = document.querySelector("[data-testid='issue-draft-delete-button']") as HTMLButtonElement | null;
    await act(async () => {
      deleteButton?.click();
    });

    const storedDrafts = JSON.parse(window.localStorage.getItem(ISSUE_DRAFTS_STORAGE_KEY) ?? "[]") as Array<{ id: string }>;
    expect(storedDrafts.map((draft) => draft.id)).toEqual(["draft-1"]);
    expect(document.querySelector("[data-testid='issue-draft-card']")).not.toBeNull();
    expect(mockState.pushToast).not.toHaveBeenCalled();
  });
});
