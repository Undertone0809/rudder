// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __clearLibraryEntryMetadataCacheForTests, __setLibraryEntryMetadataCacheForTests } from "../lib/library-entry-cache";
import { OrganizationWorkspaceFilesSidebar, OrganizationWorkspaces, WorkspaceLaunchTargetIcon } from "./OrganizationWorkspaces";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
  setHeaderActions: vi.fn(),
  navigate: vi.fn(),
  pushToast: vi.fn(),
  setSearchParams: vi.fn(),
  uploadImage: vi.fn(),
  searchParams: "path=artifacts/chat-ui-review/image.png",
  viewedOrganizationId: "org-1",
  viewedOrganizationIssuePrefix: "RUD",
  desktopShell: null as unknown,
  loadingWorkspaceFilePaths: new Set<string>(),
  loadingLibraryEntryIds: new Set<string>(),
  markdownEditorValues: [] as string[],
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
          {
            name: "agents",
            displayLabel: "agents",
            path: "agents",
            isDirectory: true,
            entityType: "organization_workspace",
          },
          {
            name: "projects",
            displayLabel: "projects",
            path: "projects",
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
            name: "proposal.html",
            displayLabel: "proposal.html",
            path: "artifacts/chat-ui-review/proposal.html",
            isDirectory: false,
            entityType: "organization_workspace",
          },
          {
            name: "evals.json",
            displayLabel: "evals.json",
            path: "artifacts/chat-ui-review/evals.json",
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
        agents: [
          {
            name: "wesley",
            displayLabel: "Wesley",
            path: "agents/wesley",
            isDirectory: true,
            entityType: "agent_workspace",
            agentRole: "developer",
            agentIcon: null,
          },
        ],
        "agents/wesley": [
          {
            name: "skills",
            displayLabel: "skills",
            path: "agents/wesley/skills",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        "agents/wesley/skills": [
          {
            name: "build-advisor",
            displayLabel: "build-advisor",
            path: "agents/wesley/skills/build-advisor",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        "agents/wesley/skills/build-advisor": [
          {
            name: "references",
            displayLabel: "references",
            path: "agents/wesley/skills/build-advisor/references",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        projects: [
          {
            name: "rudder-dev",
            displayLabel: "Rudder dev",
            path: "projects/rudder-dev",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        "projects/rudder-dev": [
          {
            name: "PROJECT.md",
            displayLabel: "PROJECT.md",
            path: "projects/rudder-dev/PROJECT.md",
            isDirectory: false,
            entityType: "organization_workspace",
          },
        ],
        skills: [
          {
            name: "build-advisor",
            displayLabel: "build-advisor",
            path: "skills/build-advisor",
            isDirectory: true,
            entityType: "organization_workspace",
          },
        ],
        "skills/build-advisor": [
          {
            name: "references",
            displayLabel: "references",
            path: "skills/build-advisor/references",
            isDirectory: true,
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
      if (mockState.loadingWorkspaceFilePaths.has(String(filePath))) {
        return {
          data: null,
          isLoading: true,
          error: null,
        };
      }
      if (String(filePath).endsWith(".html")) {
        return {
          data: {
            filePath,
            content: "<!doctype html><html><body><h1>Rendered proposal</h1><p>HTML output.</p></body></html>",
            contentType: "text/html",
            previewKind: "text",
            truncated: false,
          },
          isLoading: false,
          error: null,
        };
      }
      if (String(filePath).endsWith(".json")) {
        return {
          data: {
            filePath,
            content: "{\n  \"skill_name\": \"debug-run-transcript\",\n  \"evals\": [\n    { \"id\": 0, \"prompt\": \"Debug failed run\" }\n  ]\n}\n",
            contentType: "application/json",
            previewKind: "text",
            truncated: false,
          },
          isLoading: false,
          error: null,
        };
      }
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
    if (key[2] === "library-document") {
      return {
        data: {
          id: key[3] ?? "doc-1",
          orgId: "org-1",
          title: "Migrated plan",
          format: "markdown",
          body: "# Migrated plan\n\nOpen from Chat without mounting workspace tabs.",
          latestRevisionId: "revision-1",
          latestRevisionNumber: 3,
          createdByAgentId: null,
          createdByUserId: "user-1",
          updatedByAgentId: null,
          updatedByUserId: "user-1",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
          issueLinks: [
            {
              issueId: "issue-1",
              issueIdentifier: "RUD-1",
              issueTitle: "Example issue",
              key: "plan",
            },
          ],
        },
        isLoading: false,
        error: null,
      };
    }
    if (key[2] === "library-entry") {
      const entryId = String(key[3] ?? "");
      if (!entryId) return { data: null, isLoading: false, error: null };
      if (mockState.loadingLibraryEntryIds.has(entryId)) {
        return {
          data: null,
          isLoading: true,
          error: null,
        };
      }
      return {
        data: {
          id: entryId || "entry-1",
          orgId: "org-1",
          kind: "file",
          sourceType: "workspace_file",
          currentPath: "artifacts/chat-ui-review/notes.md",
          title: "notes.md",
          status: "active",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
        isLoading: false,
        error: null,
      };
    }
    if (key[0] === "organization-skills" && key.length === 2) {
      return {
        data: [
          {
            id: "skill-rudder",
            orgId: "org-1",
            key: "organization/org-1/rudder",
            slug: "rudder",
            name: "Bundled Rudder",
            description: "Rudder operating skill",
            sourceType: "catalog",
            sourceLocator: "skills/rudder",
            sourceRef: null,
            trustLevel: "markdown_only",
            compatibility: "compatible",
            fileInventory: [{ path: "SKILL.md", kind: "skill" }],
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            updatedAt: new Date("2026-06-01T00:00:00.000Z"),
            attachedAgentCount: 3,
            editable: false,
            editableReason: "Bundled skills are read only.",
            sourceLabel: "Bundled by Rudder",
            sourceBadge: "rudder",
            sourcePath: null,
            workspaceEditPath: null,
          },
          {
            id: "skill-build-advisor",
            orgId: "org-1",
            key: "organization/org-1/build-advisor",
            slug: "build-advisor",
            name: "Build Advisor",
            description: "Workspace-backed skill",
            sourceType: "local_path",
            sourceLocator: "skills/build-advisor",
            sourceRef: null,
            trustLevel: "markdown_only",
            compatibility: "compatible",
            fileInventory: [{ path: "SKILL.md", kind: "skill" }],
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            updatedAt: new Date("2026-06-01T00:00:00.000Z"),
            attachedAgentCount: 1,
            editable: true,
            editableReason: null,
            sourceLabel: "Library",
            sourceBadge: "local",
            sourcePath: "/tmp/rudder-org/skills/build-advisor",
            workspaceEditPath: "skills/build-advisor/SKILL.md",
          },
        ],
        isLoading: false,
        error: null,
      };
    }
    if (key[0] === "organization-skills" && key[3] === "file") {
      return {
        data: {
          skillId: key[2],
          path: key[4] ?? "SKILL.md",
          kind: "skill",
          content: "# Bundled Rudder\n\nRead-only bundled skill.",
          language: "markdown",
          markdown: true,
          editable: false,
        },
        isLoading: false,
        error: null,
      };
    }
    if (key[0] === "projects" && key.length === 2) {
      return {
        data: [
          {
            id: "project-rudder",
            orgId: "org-1",
            urlKey: "rudder-dev",
            goalId: null,
            goalIds: [],
            goals: [],
            name: "Rudder dev",
            description: null,
            status: "in_progress",
            leadAgentId: null,
            targetDate: null,
            color: null,
            pauseReason: null,
            pausedAt: null,
            executionWorkspacePolicy: null,
            codebase: {
              configured: true,
              scope: "organization",
              workspaceId: null,
              repoUrl: null,
              repoRef: null,
              defaultRef: null,
              repoName: null,
              localFolder: null,
              managedFolder: "",
              effectiveLocalFolder: "",
              origin: "local_folder",
            },
            resources: [],
            workspaces: [],
            primaryWorkspace: null,
            archivedAt: null,
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            updatedAt: new Date("2026-06-01T00:00:00.000Z"),
          },
        ],
        isLoading: false,
        error: null,
      };
    }
    return { data: null, isLoading: false, error: null };
  }),
  useMutation: vi.fn((options?: {
    mutationFn?: (payload: unknown) => unknown;
    onError?: (error: unknown) => void;
    onSuccess?: (result: unknown) => void;
  }) => {
    const mutateAsync = vi.fn(async (payload: unknown) => {
      try {
        const result = options?.mutationFn ? await options.mutationFn(payload) : undefined;
        options?.onSuccess?.(result);
        return result;
      } catch (error) {
        options?.onError?.(error);
        throw error;
      }
    });
    return {
      mutate: vi.fn((payload: unknown) => {
        void mutateAsync(payload);
      }),
      mutateAsync,
      isPending: false,
      isError: false,
    };
  }),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  })),
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: (...args: unknown[]) => mockState.uploadImage(...args),
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockState.navigate,
  useSearchParams: () => [
    new URLSearchParams(mockState.searchParams),
    mockState.setSearchParams,
  ],
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ locale: "en", t: (key: string) => key }),
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
    imageUploadHandler,
  }: {
    value?: string;
    imageUploadHandler?: (file: File) => Promise<string>;
    onInlineTokenClick?: (
      token: {
        element: HTMLElement;
        href: string;
        kind: "mention";
        label: string;
      },
      event: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
    ) => void;
  }) => {
    mockState.markdownEditorValues.push(value ?? "");
    return (
      <div>
        <div contentEditable suppressContentEditableWarning data-testid="mock-markdown-editor-content">
          {value ?? ""}
        </div>
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
        <button
          type="button"
          data-testid="mock-library-upload-image"
          onClick={() => {
            void imageUploadHandler?.(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "screenshot.png", {
              type: "image/png",
            }));
          }}
        >
          Upload image
        </button>
      </div>
    );
  },
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: string; className?: string }) => (
    <div className={className} data-testid="mock-markdown-body">
      {children}
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
  mockState.uploadImage.mockResolvedValue({
    assetId: "asset-1",
    contentPath: "/api/assets/asset-1/content",
  });
  mockState.searchParams = "path=artifacts/chat-ui-review/image.png";
  mockState.viewedOrganizationId = "org-1";
  mockState.viewedOrganizationIssuePrefix = "RUD";
  mockState.loadingWorkspaceFilePaths.clear();
  mockState.loadingLibraryEntryIds.clear();
  mockState.markdownEditorValues = [];
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
  __clearLibraryEntryMetadataCacheForTests();
  vi.unstubAllGlobals();
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

function createTabDragEvent(type: string, dataTransfer: DataTransferStub, clientX = 75, clientY = 18) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  return event;
}

function createDataTransferStub() {
  const data = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    getData: vi.fn((type: string) => data.get(type) ?? ""),
    get types() {
      return Array.from(data.keys());
    },
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value);
    }),
    setDragImage: vi.fn(),
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

  it("moves workspace launch targets into the Library sidebar menu", async () => {
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
        { id: "cursor", label: "Cursor", kind: "ide" },
        { id: "vscode", label: "VS Code", kind: "ide" },
      ]),
      openWorkspace: vi.fn(),
    };

    if (!currentContainer) {
      currentContainer = document.createElement("div");
      document.body.appendChild(currentContainer);
    }

    act(() => {
      currentRoot ??= createRoot(currentContainer!);
      currentRoot.render(
        <>
          <OrganizationWorkspaceFilesSidebar />
          <OrganizationWorkspaces />
        </>,
      );
    });
    cleanupFn = () => currentRoot?.unmount();

    await act(async () => {
      await Promise.resolve();
    });

    const launcher = document.querySelector("[data-testid='org-workspaces-sidebar-launcher']");
    expect(launcher).not.toBeNull();
    expect(launcher?.getAttribute("aria-label")).toBe("Open Library menu");
    expect(launcher?.textContent).not.toContain("VS Code");
    expect(document.querySelector("[data-testid='org-workspaces-editor-launcher']")).toBeNull();

    act(() => {
      launcher?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });

    expect(document.querySelector("[data-testid='org-workspaces-sidebar-launch-target-cursor']")).not.toBeNull();
    expect(document.querySelector("[data-testid='org-workspaces-sidebar-launch-target-vscode']")).not.toBeNull();
  });

  it("does not wrap native workspace launcher app icons in a card shell", () => {
    if (!currentContainer) {
      currentContainer = document.createElement("div");
      document.body.appendChild(currentContainer);
    }

    act(() => {
      currentRoot ??= createRoot(currentContainer!);
      currentRoot.render(
        <WorkspaceLaunchTargetIcon
          target={{
            id: "finder",
            label: "Finder",
            kind: "folder",
            iconDataUrl: "data:image/png;base64,AAAA",
          }}
        />,
      );
    });
    cleanupFn = () => currentRoot?.unmount();

    const iconSlot = document.querySelector("[data-workspace-launch-target-icon='finder']");
    expect(iconSlot).not.toBeNull();
    expect(iconSlot?.classList.contains("border")).toBe(false);
    expect(iconSlot?.className).not.toContain("bg-");
    expect(iconSlot?.className).not.toContain("shadow");
    expect(iconSlot?.className).not.toContain("rounded");
    expect(iconSlot?.querySelector("img")?.className).not.toContain("drop-shadow");
  });

  it("marks only the empty editor tab-strip space for desktop window dragging", async () => {
    renderWorkspacesPage();

    const tabStrip = document.querySelector("[data-testid='org-workspaces-editor-tabs']");
    const editorContent = document.querySelector("[data-testid='org-workspaces-editor-content']");
    const fileTab = document.querySelector("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab");
    const dragSpacer = document.querySelector("[data-testid='org-workspaces-editor-tabs'] .rudder-doc-editor-tab-drag-spacer");
    expect(tabStrip?.classList.contains("rudder-doc-editor-tab-strip--desktop-chrome")).toBe(true);
    expect(tabStrip?.className).toContain("bg-transparent");
    expect(tabStrip?.className).not.toContain("bg-[color:var(--surface-elevated)]");
    expect(tabStrip?.className).not.toContain("bg-[color:var(--surface-page)]");
    expect(editorContent?.className).toContain("bg-[color:var(--surface-elevated)]");
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

  it("keeps the selected Library tree source quiet while dragging", async () => {
    mockState.searchParams = "path=artifacts/chat-ui-review/README.md";
    renderWorkspacesPage();

    const sourceRow = document.querySelector(
      '[data-workspace-entry-path="artifacts/chat-ui-review/README.md"]',
    ) as HTMLElement | null;
    expect(sourceRow).not.toBeNull();
    expect(sourceRow?.className).toContain("bg-accent");

    const dataTransfer = createDataTransferStub();
    await act(async () => {
      sourceRow?.dispatchEvent(createTabDragEvent("dragstart", dataTransfer, 42, 14));
    });

    expect(sourceRow?.getAttribute("data-dragging-workspace-entry")).toBe("true");
    expect(sourceRow?.classList.contains("rudder-workspace-tree-entry--dragging")).toBe(true);
    expect(sourceRow?.className).not.toContain("bg-accent");
    expect(dataTransfer.setDragImage).toHaveBeenCalledTimes(1);

    await act(async () => {
      sourceRow?.dispatchEvent(createTabDragEvent("dragend", dataTransfer, 42, 14));
    });

    expect(sourceRow?.getAttribute("data-dragging-workspace-entry")).toBeNull();
    expect(sourceRow?.className).toContain("bg-accent");
  });

  it("uses the project-specific icon for Rudder project folders in the Library tree", () => {
    mockState.searchParams = "directory=projects/rudder-dev";
    renderWorkspacesPage();

    const projectRow = document.querySelector(
      '[data-workspace-entry-path="projects/rudder-dev"]',
    ) as HTMLElement | null;
    expect(projectRow).not.toBeNull();
    expect(projectRow?.textContent).toContain("Rudder dev");
    expect(projectRow?.querySelector('[data-testid="org-workspaces-project-icon"]')).not.toBeNull();
  });

  it("uses product-specific icons for agents and skills roots in the Library tree", () => {
    renderWorkspacesPage();

    const agentsRow = document.querySelector('[data-workspace-entry-path="agents"]') as HTMLElement | null;
    const skillsRow = document.querySelector('[data-workspace-entry-path="skills"]') as HTMLElement | null;

    expect(agentsRow).not.toBeNull();
    expect(skillsRow).not.toBeNull();
    expect(agentsRow?.querySelector('[data-testid="org-workspaces-agents-root-icon"]')).not.toBeNull();
    expect(skillsRow?.querySelector('[data-testid="org-workspaces-skills-root-icon"]')).not.toBeNull();
  });

  it("shows read-only organization skills under the Library skills directory without duplicating workspace-backed skills", () => {
    mockState.searchParams = "directory=skills";
    renderWorkspacesPage();

    const bundledSkillRow = document.querySelector('[data-workspace-entry-path="skills/rudder"]') as HTMLElement | null;
    const workspaceBackedRows = document.querySelectorAll('[data-workspace-entry-path="skills/build-advisor"]');
    const workspaceBackedSkillRow = workspaceBackedRows[0] as HTMLElement | undefined;

    expect(bundledSkillRow).not.toBeNull();
    expect(bundledSkillRow?.textContent).toContain("Bundled Rudder");
    expect(bundledSkillRow?.querySelector('[data-testid="org-workspaces-skill-folder-icon"]')).not.toBeNull();
    expect(workspaceBackedRows).toHaveLength(1);
    expect(workspaceBackedSkillRow?.querySelector('[data-testid="org-workspaces-skill-folder-icon"]')).not.toBeNull();
  });

  it("keeps nested folders inside skills as regular folders", () => {
    mockState.searchParams = "directory=skills/build-advisor";
    renderWorkspacesPage();

    const skillRow = document.querySelector('[data-workspace-entry-path="skills/build-advisor"]') as HTMLElement | null;
    const nestedFolderRow = document.querySelector('[data-workspace-entry-path="skills/build-advisor/references"]') as HTMLElement | null;

    expect(skillRow?.querySelector('[data-testid="org-workspaces-skill-folder-icon"]')).not.toBeNull();
    expect(nestedFolderRow).not.toBeNull();
    expect(nestedFolderRow?.querySelector('[data-testid="org-workspaces-skill-folder-icon"]')).toBeNull();
  });

  it("uses skill icons for agent Library skill folders", () => {
    mockState.searchParams = "directory=agents/wesley/skills/build-advisor";
    renderWorkspacesPage();

    const skillRow = document.querySelector('[data-workspace-entry-path="agents/wesley/skills/build-advisor"]') as HTMLElement | null;
    const nestedFolderRow = document.querySelector('[data-workspace-entry-path="agents/wesley/skills/build-advisor/references"]') as HTMLElement | null;

    expect(skillRow?.querySelector('[data-testid="org-workspaces-skill-folder-icon"]')).not.toBeNull();
    expect(nestedFolderRow).not.toBeNull();
    expect(nestedFolderRow?.querySelector('[data-testid="org-workspaces-skill-folder-icon"]')).toBeNull();
  });

  it("opens read-only bundled skill files from the Library skills tree", () => {
    mockState.searchParams = "skill=skill-rudder&skillFile=SKILL.md";
    renderWorkspacesPage();

    const readOnlyPanel = document.querySelector("[data-testid='org-workspaces-virtual-skill-readonly']");
    expect(readOnlyPanel).not.toBeNull();
    expect(readOnlyPanel?.textContent).toContain("Read-only bundled skill");
    expect(readOnlyPanel?.textContent).toContain("Bundled skills are read only");
    expect(document.querySelector("[data-testid='org-workspaces-editor-status-bar']")).toBeNull();

    const breadcrumb = document.querySelector("[data-testid='org-workspaces-path-breadcrumb']");
    expect(breadcrumb?.textContent).toContain("Bundled Rudder");
    const skillParentButton = Array.from(breadcrumb?.querySelectorAll("button") ?? []).find(
      (button) => button.getAttribute("title") === "skills/rudder",
    );
    expect(skillParentButton).toBeTruthy();

    act(() => {
      skillParentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const nextParams = mockState.setSearchParams.mock.calls.at(-1)?.[0] as URLSearchParams | undefined;
    expect(nextParams?.get("directory")).toBe("skills/rudder");
    expect(nextParams?.has("skill")).toBe(false);
  });

  it("redirects workspace-backed skill deep links to their editable Library file", () => {
    mockState.searchParams = "skill=skill-build-advisor&skillFile=SKILL.md";
    renderWorkspacesPage();

    const nextParams = mockState.setSearchParams.mock.calls.at(-1)?.[0] as URLSearchParams | undefined;
    expect(nextParams?.get("path")).toBe("skills/build-advisor/SKILL.md");
    expect(nextParams?.has("skill")).toBe(false);
    expect(nextParams?.has("skillFile")).toBe(false);
    expect(document.querySelector("[data-testid='org-workspaces-virtual-skill-readonly']")).toBeNull();
  });

  it("opens an add-skill dialog from the skills row with a prefilled Agent install path", async () => {
    mockState.searchParams = "directory=skills";
    renderWorkspacesPage();

    await act(async () => {
      document.querySelector("[data-testid='org-workspaces-skills-add-button']")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(document.body.textContent).toContain("Add skill to Library");
    expect(document.body.textContent).toContain("Import or move a skill");

    await act(async () => {
      document.querySelector("[data-testid='org-workspaces-skill-agent-install-button']")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(mockState.navigate).toHaveBeenCalledWith(expect.stringContaining("/messenger/chat?prefill="));
    const target = String(mockState.navigate.mock.calls.at(-1)?.[0] ?? "");
    expect(decodeURIComponent(target)).toContain("Install or import a skill into this Rudder organization");
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

  it("renders Library HTML files as sandboxed previews instead of raw source", async () => {
    renderWorkspacesPage();

    const htmlFileButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "proposal.html",
    );
    expect(htmlFileButton).toBeTruthy();

    await act(async () => {
      htmlFileButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const preview = document.querySelector<HTMLIFrameElement>("[data-testid='org-workspaces-html-preview']");
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute("sandbox")).toBe("");
    expect(preview?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(preview?.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(preview?.getAttribute("srcdoc")).toContain("<h1>Rendered proposal</h1>");
    expect(document.querySelector("[data-testid='org-workspaces-editor-textarea']")).toBeNull();
    expect(document.querySelector("[data-testid='org-workspaces-html-preview-scroll']")?.textContent).not.toContain("<!doctype html>");

    const sourceButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Source",
    );
    expect(sourceButton).toBeTruthy();

    await act(async () => {
      sourceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const sourceTextarea = document.querySelector<HTMLTextAreaElement>("[data-testid='org-workspaces-editor-textarea']");
    expect(sourceTextarea).not.toBeNull();
    expect(sourceTextarea?.value).toContain("<h1>Rendered proposal</h1>");
  });

  it("uploads Library markdown images as assets instead of embedding data URLs", async () => {
    mockState.searchParams = "path=artifacts/chat-ui-review/notes.md";
    renderWorkspacesPage();

    await act(async () => {
      document.querySelector("[data-testid='mock-library-upload-image']")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(mockState.uploadImage).toHaveBeenCalledWith(
      "org-1",
      expect.any(File),
      "library/artifacts/chat-ui-review/notes",
    );
  });

  it("shows a compact editor status bar for editable Library documents", () => {
    mockState.searchParams = "path=artifacts/chat-ui-review/notes.md";
    renderWorkspacesPage();

    const statusBar = document.querySelector("[data-testid='org-workspaces-editor-status-bar']");
    expect(statusBar?.textContent).toContain("Markdown");
    expect(statusBar?.textContent).toMatch(/\d+ words?/);
    expect(statusBar?.textContent).toContain("Saved");
  });

  it("renders common code and data files with a syntax-highlighted editor", () => {
    mockState.searchParams = "path=artifacts/chat-ui-review/evals.json";
    renderWorkspacesPage();

    const editor = document.querySelector<HTMLElement>("[data-testid='org-workspaces-editor-textarea']");
    expect(editor).not.toBeNull();
    expect(editor?.tagName).toBe("DIV");
    expect(editor?.getAttribute("data-workspace-code-language")).toBe("JSON");
    expect(editor?.querySelector(".cm-editor")).not.toBeNull();
    expect(editor?.textContent).toContain("skill_name");

    const statusBar = document.querySelector("[data-testid='org-workspaces-editor-status-bar']");
    expect(statusBar?.textContent).toContain("JSON");
    expect(statusBar?.textContent).toContain("Saved");
  });

  it("opens Library keyword search from Command+F and highlights active tab content", async () => {
    mockState.searchParams = "path=artifacts/chat-ui-review/notes.md";
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    renderWorkspacesPage();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
      await Promise.resolve();
    });

    const input = document.querySelector<HTMLInputElement>("input[aria-label='Find in Library']");
    expect(input).not.toBeNull();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "README");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("1 of");
    expect(document.querySelector("[data-testid='org-workspaces-editor-content'] mark[data-issue-find-highlight='true']"))
      .not.toBeNull();
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

  it("does not mount restored Library markdown tabs with an empty draft before the file read finishes", () => {
    mockState.searchParams = "";
    mockState.loadingWorkspaceFilePaths.add("artifacts/chat-ui-review/notes.md");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => JSON.stringify({
          openFilePaths: ["artifacts/chat-ui-review/notes.md"],
          selectedFilePath: "artifacts/chat-ui-review/notes.md",
        })),
        setItem: vi.fn(),
      },
    });

    renderWorkspacesPage();

    expect(document.body.textContent).toContain("Loading file");
    expect(mockState.markdownEditorValues).toEqual([]);

    mockState.loadingWorkspaceFilePaths.clear();
    renderWorkspacesPage();

    expect(mockState.markdownEditorValues[0]).toContain(
      "[README.md](library-file://file?p=artifacts%2Fchat-ui-review%2FREADME.md&t=README.md)",
    );
  });

  it("opens legacy Library document deep links without restoring workspace file tabs", () => {
    mockState.searchParams = "doc=doc-1";
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => JSON.stringify({
          openFilePaths: ["artifacts/chat-ui-review/notes.md"],
          selectedFilePath: "artifacts/chat-ui-review/notes.md",
        })),
        setItem: vi.fn(),
      },
    });

    renderWorkspacesPage();

    expect(document.querySelector("[data-testid='org-workspaces-legacy-document']")).not.toBeNull();
    expect(document.body.textContent).toContain("Migrated plan");
    expect(document.body.textContent).toContain("Open from Chat without mounting workspace tabs.");
    expect(document.body.textContent).toContain("migrated from RUD-1:plan");
    expect(document.querySelector("[data-testid='org-workspaces-editor-tabs']")).toBeNull();
    expect(mockState.markdownEditorValues).toEqual([]);
    expect(mockState.setSearchParams).not.toHaveBeenCalled();
  });

  it("opens cached Library entry links without the entry loading skeleton", () => {
    mockState.searchParams = "entry=entry-1";
    __setLibraryEntryMetadataCacheForTests("org-1", {
      id: "entry-1",
      orgId: "org-1",
      kind: "file",
      sourceType: "workspace_file",
      currentPath: "artifacts/chat-ui-review/notes.md",
      title: "notes.md",
      status: "active",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    renderWorkspacesPage();

    expect(document.body.textContent).not.toContain("Loading file");
    expect(document.querySelector("[data-testid='org-workspaces-editor-tabs']")?.textContent).toContain("notes.md");
    expect(mockState.markdownEditorValues[0]).toContain(
      "[README.md](library-file://file?p=artifacts%2Fchat-ui-review%2FREADME.md&t=README.md)",
    );
  });

  it("opens path-hinted Library entry links while the entry metadata request is still pending", () => {
    mockState.searchParams = "entry=entry-1&path=artifacts%2Fchat-ui-review%2Fnotes.md";
    mockState.loadingLibraryEntryIds.add("entry-1");

    renderWorkspacesPage();

    expect(document.body.textContent).not.toContain("Loading file");
    expect(document.body.textContent).not.toContain("This Library reference could not be found");
    expect(document.querySelector("[data-testid='org-workspaces-editor-tabs']")?.textContent).toContain("notes.md");
    expect(mockState.markdownEditorValues[0]).toContain(
      "[README.md](library-file://file?p=artifacts%2Fchat-ui-review%2FREADME.md&t=README.md)",
    );
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

    const breadcrumb = document.querySelector("[data-testid='org-workspaces-path-breadcrumb']");
    expect(breadcrumb?.textContent?.replace(/\s+/g, " ").trim()).toBe("Library/artifacts/chat-ui-review");
    expect(document.querySelector("[data-testid='org-workspaces-empty-new-document']")).not.toBeNull();
    expect(document.body.textContent).toContain("No file selected");
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
