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
      return {
        data: {
          filePath: "artifacts/chat-ui-review/image.png",
          content: null,
          contentPath: "/api/orgs/org-1/workspace/file-content/artifacts/chat-ui-review/image.png",
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
    new URLSearchParams("path=artifacts/chat-ui-review/image.png"),
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
  vi.useFakeTimers();
  vi.clearAllMocks();
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
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function renderWorkspacesPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(<OrganizationWorkspaces />);
  });
  cleanupFn = () => root?.unmount();
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

});
