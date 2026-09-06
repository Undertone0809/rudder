// @vitest-environment jsdom

import { ThemeProvider } from "@/context/ThemeContext";
import { ISSUE_REFRESH_INTERVAL_MS } from "@/lib/issue-refresh";
import { ISSUE_DRAFTS_STORAGE_KEY } from "@/lib/new-issue-dialog";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "../api/issues";
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
  issuesListProps: null as null | Record<string, unknown>,
  infiniteQueryOptions: null as null | Record<string, unknown>,
  mutationOptions: [] as Array<Record<string, unknown>>,
  initialIssues: [] as Array<{ id: string; status: string; title?: string; updatedAt?: Date | string }>,
  hasNextPage: false,
  isFetching: false,
  refetchIssues: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: (options: Record<string, unknown>) => {
    mockState.infiniteQueryOptions = options;
    return {
      data: { pages: [mockState.initialIssues] },
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: mockState.hasNextPage,
      isFetching: mockState.isFetching,
      isFetchingNextPage: false,
      isLoading: false,
      refetch: mockState.refetchIssues,
    };
  },
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "agents") return { data: mockState.agents, isLoading: false, error: null };
    if (queryKey[0] === "projects") return { data: mockState.projects, isLoading: false, error: null };
    if (queryKey[0] === "auth") return { data: mockState.session, isLoading: false, error: null };
    return { data: [], isLoading: false, error: null };
  },
  useMutation: (options: Record<string, unknown>) => {
    mockState.mutationOptions.push(options);
    return {
      mutate: vi.fn(),
    };
  },
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

vi.mock("@/context/ToastContext", () => {
  const toast = {
    pushToast: mockState.pushToast,
  };
  return {
    useOptionalToast: () => toast,
    useToast: () => toast,
  };
});

vi.mock("@/hooks/useIssueFollows", () => ({
  useIssueFollows: () => ({
    followedIssueIds: new Set<string>(),
    toggleFollowIssue: vi.fn(),
  }),
}));

vi.mock("@/components/IssuesList", () => ({
  IssuesList: (props: Record<string, unknown>) => {
    mockState.issuesListProps = props;
    return <div data-testid="issues-list">Issues list</div>;
  },
}));

let cleanupFn: (() => void) | null = null;
let rerenderIssues: (() => void) | null = null;
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
  rerenderIssues = () => {
    act(() => {
      root.render(
        <ThemeProvider>
          <Issues />
        </ThemeProvider>,
      );
    });
  };

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
  mockState.issuesListProps = null;
  mockState.infiniteQueryOptions = null;
  mockState.mutationOptions = [];
  mockState.initialIssues = [];
  mockState.hasNextPage = false;
  mockState.isFetching = false;
  vi.mocked(issuesApi.list).mockReset();
  mockState.refetchIssues.mockReset();
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
  rerenderIssues = null;
  window.localStorage.clear();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Issues agent participant scope", () => {
  it("opens the board with the assignee agent filter from the URL", () => {
    mockState.search = "?assignee=agent-1";

    renderIssues();

    expect(document.querySelector("[data-testid='issues-list']")).toBeTruthy();
    expect(mockState.issuesListProps).toMatchObject({
      initialAssignees: ["agent-1"],
    });
  });

  it("opens the board with the participant agent filter and isolated view state", () => {
    mockState.search = "?participantAgentId=agent-1";

    renderIssues();

    expect(document.querySelector("[data-testid='issues-list']")).toBeTruthy();
    expect(mockState.issuesListProps).toMatchObject({
      viewStateKey: "rudder:issues-view:agent:agent-1",
      searchFilters: { participantAgentId: "agent-1" },
    });
  });
});

describe("Issues refresh recovery", () => {
  it("polls the loaded pages and exposes a retry for the active list query", () => {
    mockState.search = "";

    renderIssues();

    expect(mockState.infiniteQueryOptions).toMatchObject({
      refetchInterval: ISSUE_REFRESH_INTERVAL_MS,
      refetchIntervalInBackground: false,
      refetchOnReconnect: "always",
      refetchOnWindowFocus: "always",
    });
    expect(mockState.issuesListProps).toMatchObject({
      hasData: true,
      isFetching: false,
    });

    (mockState.issuesListProps?.onRetry as (() => void) | undefined)?.();
    expect(mockState.refetchIssues).toHaveBeenCalledTimes(1);
  });
});

describe("Issues board pagination", () => {
  it("keeps status lane offsets independent while preserving the active sort", async () => {
    mockState.search = "";
    mockState.hasNextPage = true;
    mockState.initialIssues = [
      { id: "todo-1", status: "todo" },
      { id: "done-1", status: "done" },
    ];
    vi.mocked(issuesApi.list).mockImplementation((_orgId, filters) =>
      Promise.resolve(filters?.status === "todo" ? [] : []),
    );

    renderIssues();

    const loadMoreIssues = mockState.issuesListProps?.onLoadMoreIssues as
      ((target?: string) => void | Promise<unknown>) | undefined;
    expect(loadMoreIssues).toBeDefined();

    await act(async () => {
      await Promise.all([
        loadMoreIssues?.("todo"),
        loadMoreIssues?.("done"),
      ]);
    });

    const laneRequests = vi.mocked(issuesApi.list).mock.calls
      .map(([, filters]) => filters)
      .filter((filters) => filters?.status === "todo" || filters?.status === "done");
    expect(laneRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "todo",
        offset: 1,
        limit: 200,
        sortField: "updated",
        sortDir: "desc",
      }),
      expect.objectContaining({
        status: "done",
        offset: 1,
        limit: 200,
        sortField: "updated",
        sortDir: "desc",
      }),
    ]));
  });

  it("updates the server pagination sort when the board sort changes", () => {
    mockState.search = "";

    renderIssues();

    const onSortChange = mockState.issuesListProps?.onSortChange as
      ((sortState: { sortField: string; sortDir: string }) => void) | undefined;
    act(() => {
      onSortChange?.({ sortField: "title", sortDir: "asc" });
    });

    const queryKey = mockState.infiniteQueryOptions?.queryKey as unknown[];
    expect(queryKey).toEqual(expect.arrayContaining(["sort-field", "title", "sort-dir", "asc"]));
  });

  it("keeps refreshed query data ahead of stale board-page data", async () => {
    mockState.search = "";
    mockState.hasNextPage = true;
    mockState.initialIssues = [{
      id: "todo-1",
      status: "todo",
      title: "Fresh title",
      updatedAt: "2026-09-06T12:00:00.000Z",
    }];
    vi.mocked(issuesApi.list).mockResolvedValue([{
      id: "todo-1",
      status: "todo",
      title: "Stale title",
      updatedAt: "2026-09-06T11:00:00.000Z",
    }] as never);

    renderIssues();

    await act(async () => {
      await (mockState.issuesListProps?.onLoadMoreIssues as ((target?: string) => Promise<unknown>))("todo");
    });

    const renderedIssues = mockState.issuesListProps?.issues as Array<{ id: string; title: string }>;
    expect(renderedIssues.find((issue) => issue.id === "todo-1")?.title).toBe("Fresh title");
  });

  it("clears lane-only records after a successful issue mutation", async () => {
    mockState.search = "";
    mockState.hasNextPage = true;
    mockState.initialIssues = [{ id: "global-1", status: "todo" }];
    vi.mocked(issuesApi.list).mockResolvedValue([{
      id: "lane-only-1",
      status: "todo",
      title: "Lane-only record",
    }] as never);

    renderIssues();

    await act(async () => {
      await (mockState.issuesListProps?.onLoadMoreIssues as ((target?: string) => Promise<unknown>))("todo");
    });
    expect((mockState.issuesListProps?.issues as Array<{ id: string }>).map((issue) => issue.id))
      .toContain("lane-only-1");

    const onSuccess = mockState.mutationOptions[0]?.onSuccess as (() => void) | undefined;
    expect(onSuccess).toBeDefined();
    act(() => {
      onSuccess?.();
    });

    expect((mockState.issuesListProps?.issues as Array<{ id: string }>).map((issue) => issue.id))
      .not.toContain("lane-only-1");
  });

  it("clears lane-only records when the global query starts refreshing", async () => {
    mockState.search = "";
    mockState.hasNextPage = true;
    mockState.initialIssues = [{ id: "global-1", status: "todo" }];
    vi.mocked(issuesApi.list).mockResolvedValue([{
      id: "lane-only-1",
      status: "todo",
      title: "Lane-only record",
    }] as never);

    renderIssues();

    await act(async () => {
      await (mockState.issuesListProps?.onLoadMoreIssues as ((target?: string) => Promise<unknown>))("todo");
    });
    expect((mockState.issuesListProps?.issues as Array<{ id: string }>).map((issue) => issue.id))
      .toContain("lane-only-1");

    mockState.isFetching = true;
    rerenderIssues?.();

    expect((mockState.issuesListProps?.issues as Array<{ id: string }>).map((issue) => issue.id))
      .not.toContain("lane-only-1");
  });
});

describe("Issues draft scope", () => {
  it("centers the empty draft state without an English helper message", () => {
    window.localStorage.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify([]));

    renderIssues();

    const view = document.querySelector("[data-testid='issue-drafts-view']");
    const emptyState = view?.firstElementChild;
    expect(view?.className).toContain("items-center");
    expect(view?.className).toContain("justify-center");
    expect(emptyState?.className).toContain("w-full");
    expect(emptyState?.className).toContain("min-h-[18rem]");
    expect(view?.textContent).not.toContain("No draft issues.");
  });

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
