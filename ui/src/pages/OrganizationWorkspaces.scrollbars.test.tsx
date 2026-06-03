// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationWorkspaces } from "./OrganizationWorkspaces";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
  setHeaderActions: vi.fn(),
  pushToast: vi.fn(),
  setSearchParams: vi.fn(),
  searchParams: "path=artifacts/chat-ui-review/image.png",
  viewedOrganizationId: "org-1",
  viewedOrganizationIssuePrefix: "RUD",
  desktopShell: null as unknown,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(({ queryKey }) => {
    const key = queryKey as string[];
    if (key[2] === "workspace-files") {
      const directoryPath = key[3] ?? "";
      const entriesByPath = {
        "": [
          {
            name: "artifacts",
            displayLabel: "artifacts",
            path: "artifacts",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        artifacts: [
          {
            name: "chat-ui-review",
            displayLabel: "chat-ui-review",
            path: "artifacts/chat-ui-review",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        "artifacts/chat-ui-review": [
          {
            name: "image.png",
            displayLabel: "image.png",
            path: "artifacts/chat-ui-review/image.png",
            isDirectory: false,
            entityType: "organization_workspace",
          },
          {
            name: "notes.md",
            displayLabel: "notes.md",
            path: "artifacts/chat-ui-review/notes.md",
            isDirectory: false,
            entityType: "organization_workspace",
          },
          {
            name: "README.md",
            displayLabel: "README.md",
            path: "artifacts/chat-ui-review/README.md",
            isDirectory: false,
            entityType: "organization_workspace",
          },
        ],
      } as const;
      return {
        data: {
          rootExists: true,
          rootPath: "/tmp/rudder-org",
          directoryPath,
          entries: entriesByPath[directoryPath as keyof typeof entriesByPath] ?? [],
        },
        isLoading: false,
        error: null,
      };
    }
    if (key[2] === "workspace-file") {
      const filePath = key[3] ?? "artifacts/chat-ui-review/image.png";
      if (String(filePath).endsWith(".md")) {
        return {
          data: {
            filePath,
            content: String(filePath).endsWith("notes.md")
              ? "[README.md](library-file://file?p=artifacts%2Fchat-ui-review%2FREADME.md&t=README.md)\n"
              : `# ${filePath}\n`,
            contentType: "text/markdown",
            previewKind: "text",
            truncated: false,
          },
          isLoading: false,
          error: null,
        };
      }
      return {
        data: {
          filePath,
          content: null,
          contentPath: `/api/orgs/org-1/workspace/file-content/${filePath}`,
          contentType: "image/png",
          previewKind: "image",
          truncated: false,
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

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockState.setBreadcrumbs,
    setHeaderActions: mockState.setHeaderActions,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: mockState.pushToast,
  }),
}));

vi.mock("../hooks/useViewedOrganization", () => ({
  useViewedOrganization: () => ({
    viewedOrganizationId: mockState.viewedOrganizationId,
    viewedOrganization: {
      id: mockState.viewedOrganizationId,
      name: "Rudder",
      issuePrefix: mockState.viewedOrganizationIssuePrefix,
    },
  }),
}));

vi.mock("../lib/desktop-shell", () => ({
  readDesktopShell: () => mockState.desktopShell,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onInlineTokenClick,
  }: {
    value?: string;
    onInlineTokenClick?: (
      token: {
        element: HTMLElement;
        href: string;
        kind: "mention";
        label: string;
      },
      event: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
    ) => void;
  }) => (
    <div>
      <textarea aria-label="Markdown editor" readOnly value={value ?? ""} />
      <button
        type="button"
        data-testid="mock-library-file-token"
        onClick={(event) => onInlineTokenClick?.(
          {
            element: event.currentTarget,
            href: "library-file://file?p=artifacts%2Fchat-ui-review%2FREADME.md&t=README.md",
            kind: "mention",
            label: "README.md",
          },
          event,
        )}
      >
        README.md
      </button>
    </div>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: import("react").ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
}));

let cleanupFn: (() => void) | null = null;
let currentRoot: Root | null = null;
let currentContainer: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockState.searchParams = "path=artifacts/chat-ui-review/image.png";
  mockState.viewedOrganizationId = "org-1";
  mockState.viewedOrganizationIssuePrefix = "RUD";
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    },
  });
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    },
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 500,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("767px"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  mockState.desktopShell = null;
});

afterEach(() => {
  act(() => {
    cleanupFn?.();
  });
  cleanupFn = null;
  currentRoot = null;
  currentContainer = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function renderWorkspacesPage() {
  if (!currentContainer) {
    currentContainer = document.createElement("div");
    document.body.appendChild(currentContainer);
  }
  act(() => {
    currentRoot ??= createRoot(currentContainer!);
    currentRoot.render(<OrganizationWorkspaces />);
  });
  cleanupFn = () => currentRoot?.unmount();
}

function createTabDragEvent(type: string, dataTransfer: DataTransferStub, clientX = 75) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: clientX });
  return event;
}

function createDataTransferStub() {
  const data = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    getData: vi.fn((type: string) => data.get(type) ?? ""),
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value);
    }),
  };
}

type DataTransferStub = ReturnType<typeof createDataTransferStub>;

describe("OrganizationWorkspaces scroll regions", () => {
  it("uses separate auto-hidden scroll regions for files and editor preview", () => {
    renderWorkspacesPage();

    const filesScroll = document.querySelector("[data-testid='org-workspaces-files-scroll']");
    const editorScroll = document.querySelector("[data-testid='org-workspaces-image-preview-scroll']");
    expect(filesScroll?.classList.contains("scrollbar-auto-hide")).toBe(true);
    expect(editorScroll?.classList.contains("scrollbar-auto-hide")).toBe(true);
    expect(filesScroll?.classList.contains("overflow-auto")).toBe(true);
    expect(editorScroll?.classList.contains("overflow-auto")).toBe(true);

    act(() => {
      filesScroll?.dispatchEvent(new Event("scroll"));
    });
    expect(filesScroll?.classList.contains("is-scrolling")).toBe(true);
    expect(editorScroll?.classList.contains("is-scrolling")).toBe(false);

    act(() => {
      editorScroll?.dispatchEvent(new Event("scroll"));
    });
    expect(editorScroll?.classList.contains("is-scrolling")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(701);
    });
    expect(filesScroll?.classList.contains("is-scrolling")).toBe(false);
    expect(editorScroll?.classList.contains("is-scrolling")).toBe(false);
  });

  it("does not crash when the desktop shell bridge is missing newer workspace launch methods", () => {
    mockState.desktopShell = {};

    expect(() => renderWorkspacesPage()).not.toThrow();
    expect(document.querySelector("[data-testid='org-workspaces-files-scroll']")).not.toBeNull();
  });

  it("keeps the workspace launcher icon-only while preserving the accessible app label", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    mockState.desktopShell = {
      listAvailableIdes: vi.fn().mockResolvedValue([{ id: "vscode", label: "VS Code" }]),
      listWorkspaceLaunchTargets: vi.fn().mockResolvedValue([
        { id: "vscode", label: "VS Code", kind: "ide" },
      ]),
      openWorkspace: vi.fn(),
    };

    renderWorkspacesPage();

    await act(async () => {
      await Promise.resolve();
    });

    const launcher = document.querySelector("[data-testid='org-workspaces-editor-launcher']");
    const openButton = launcher?.querySelector("button[aria-label='Open workspace in VS Code']");
    expect(launcher).not.toBeNull();
    expect(openButton).not.toBeNull();
    expect(openButton?.textContent).toBe("VS");
    expect(launcher?.textContent).not.toContain("VS Code");
  });

  it("marks only the empty editor tab-strip space for desktop window dragging", async () => {
    renderWorkspacesPage();

    const tabStrip = document.querySelector("[data-testid='org-workspaces-editor-tabs']");
    const fileTab = document.querySelector("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab");
    const dragSpacer = document.querySelector("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab-drag-spacer");
    expect(tabStrip?.classList.contains("rudder-doc-editor-tab-strip--desktop-chrome")).toBe(true);
    expect(fileTab?.classList.contains("rudder-doc-editor-tab--desktop-no-drag")).toBe(true);
    expect(dragSpacer).not.toBeNull();

    const notesFileButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "notes.md",
    );
    expect(notesFileButton).toBeTruthy();

    await act(async () => {
      notesFileButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const fileTabs = Array.from(
      document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab"),
    );
    expect(fileTabs).toHaveLength(2);
    expect(fileTabs.map((tab) => tab.getAttribute("draggable"))).toEqual(["true", "true"]);
    expect(fileTabs.every((tab) => tab.classList.contains("rudder-doc-editor-tab--desktop-no-drag"))).toBe(true);

    Object.defineProperty(fileTabs[1], "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 40,
        height: 40,
        left: 0,
        right: 100,
        top: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    const dataTransfer = createDataTransferStub();
    await act(async () => {
      fileTabs[0].dispatchEvent(createTabDragEvent("dragstart", dataTransfer));
      fileTabs[1].dispatchEvent(createTabDragEvent("dragover", dataTransfer, 75));
      fileTabs[1].dispatchEvent(createTabDragEvent("drop", dataTransfer, 75));
    });

    expect(
      Array.from(document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab"))
        .map((tab) => tab.textContent?.trim()),
    ).toEqual(["notes.md", "image.png"]);
  });

  it("opens Library file tokens inside the current editor tab set", async () => {
    renderWorkspacesPage();

    const notesFileButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "notes.md",
    );
    expect(notesFileButton).toBeTruthy();

    await act(async () => {
      notesFileButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(
      Array.from(document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab"))
        .map((tab) => tab.textContent?.trim()),
    ).toEqual(["image.png", "notes.md"]);

    await act(async () => {
      document.querySelector("[data-testid='mock-library-file-token']")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    const fileTabs = Array.from(
      document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab"),
    );
    expect(fileTabs.map((tab) => tab.textContent?.trim())).toEqual(["image.png", "notes.md", "README.md"]);
    expect(fileTabs.map((tab) => tab.querySelector("[role='tab']")?.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
    ]);
  });

  it("closes the current Library file tab on command-w without allowing the browser shortcut", async () => {
    renderWorkspacesPage();

    const notesFileButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "notes.md",
    );
    expect(notesFileButton).toBeTruthy();

    await act(async () => {
      notesFileButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(
      Array.from(document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab"))
        .map((tab) => tab.textContent?.trim()),
    ).toEqual(["image.png", "notes.md"]);

    const closeShortcut = new KeyboardEvent("keydown", {
      key: "w",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(closeShortcut);
    });

    expect(closeShortcut.defaultPrevented).toBe(true);
    const fileTabs = Array.from(
      document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab"),
    );
    expect(fileTabs.map((tab) => tab.textContent?.trim())).toEqual(["image.png"]);
    expect(fileTabs.map((tab) => tab.querySelector("[role='tab']")?.getAttribute("aria-selected"))).toEqual(["true"]);
  });

  it("scrolls the selected editor tab into view when opening a file from the tree", async () => {
    renderWorkspacesPage();

    const tabScroller = document.querySelector(".rudder-doc-editor-tab-scroller") as HTMLDivElement | null;
    expect(tabScroller).not.toBeNull();
    Object.defineProperty(tabScroller, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(tabScroller, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 40,
        height: 40,
        left: 0,
        right: 240,
        top: 0,
        width: 240,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    const notesFileButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "notes.md",
    );
    expect(notesFileButton).toBeTruthy();

    await act(async () => {
      notesFileButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const notesTab = Array.from(
      document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab"),
    ).find((tab) => tab.textContent?.trim() === "notes.md");
    expect(notesTab).toBeTruthy();
    Object.defineProperty(notesTab!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 40,
        height: 40,
        left: 260,
        right: 392,
        top: 0,
        width: 132,
        x: 260,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(tabScroller?.scrollLeft).toBe(152);
  });

  it("restores open Library file tabs from session storage when no file path is requested", () => {
    mockState.searchParams = "";
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => JSON.stringify([
          "artifacts/chat-ui-review/notes.md",
          "artifacts/chat-ui-review/README.md",
        ])),
        setItem: vi.fn(),
      },
    });

    renderWorkspacesPage();

    const fileTabs = Array.from(
      document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab"),
    );
    expect(fileTabs.map((tab) => tab.textContent?.trim())).toEqual(["notes.md", "README.md"]);
    expect(fileTabs.map((tab) => tab.querySelector("[role='tab']")?.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
    ]);
  });

  it("replaces retained Library tabs when switching organizations without unmounting", () => {
    mockState.searchParams = "";
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => {
          if (key.endsWith(":org-1")) {
            return JSON.stringify({
              openFilePaths: ["artifacts/chat-ui-review/notes.md"],
              selectedFilePath: "artifacts/chat-ui-review/notes.md",
            });
          }
          if (key.endsWith(":org-2")) {
            return JSON.stringify({
              openFilePaths: ["artifacts/chat-ui-review/README.md"],
              selectedFilePath: "artifacts/chat-ui-review/README.md",
            });
          }
          return null;
        }),
        setItem: vi.fn(),
      },
    });

    renderWorkspacesPage();
    expect(
      Array.from(document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab"))
        .map((tab) => tab.textContent?.trim()),
    ).toEqual(["notes.md"]);

    mockState.viewedOrganizationId = "org-2";
    mockState.viewedOrganizationIssuePrefix = "ALT";
    renderWorkspacesPage();

    const fileTabs = Array.from(
      document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab"),
    );
    expect(fileTabs.map((tab) => tab.textContent?.trim())).toEqual(["README.md"]);
    expect(fileTabs.map((tab) => tab.querySelector("[role='tab']")?.getAttribute("aria-selected"))).toEqual(["true"]);
  });

  it("does not let retained Library tabs override a directory deep link", () => {
    mockState.searchParams = "directory=artifacts/chat-ui-review";
    const setItem = vi.fn();
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => JSON.stringify({
          openFilePaths: ["artifacts/chat-ui-review/notes.md", "artifacts/chat-ui-review/README.md"],
          selectedFilePath: "artifacts/chat-ui-review/README.md",
        })),
        setItem,
      },
    });

    renderWorkspacesPage();

    expect(document.querySelector("[data-testid='org-workspaces-path-breadcrumb']")).toBeNull();
    expect(
      document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] [role='tab'][aria-selected='true']"),
    ).toHaveLength(0);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("does not let retained Library tabs override a resource deep link", () => {
    mockState.searchParams = "resource=resource-1";
    const setItem = vi.fn();
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => JSON.stringify({
          openFilePaths: ["artifacts/chat-ui-review/notes.md", "artifacts/chat-ui-review/README.md"],
          selectedFilePath: "artifacts/chat-ui-review/README.md",
        })),
        setItem,
      },
    });

    renderWorkspacesPage();

    expect(document.querySelector("[data-testid='org-workspaces-path-breadcrumb']")).toBeNull();
    expect(
      document.querySelectorAll("[data-testid='org-workspaces-editor-tabs'] [role='tab'][aria-selected='true']"),
    ).toHaveLength(0);
    expect(setItem).not.toHaveBeenCalled();
  });

});
