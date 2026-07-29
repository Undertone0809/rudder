// @vitest-environment jsdom


import { ToastProvider } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import type {
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceFileList,
} from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { LibraryLiveSurface } from "./LibraryLiveSurface";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const getLibraryDocument = vi.hoisted(() => vi.fn());
const getLibraryEntry = vi.hoisted(() => vi.fn());
const listWorkspaceFiles = vi.hoisted(() => vi.fn());
const readWorkspaceFile = vi.hoisted(() => vi.fn());
const updateWorkspaceFile = vi.hoisted(() => vi.fn());

vi.mock("@/api/orgs", () => ({
  organizationsApi: {
    getLibraryDocument,
    getLibraryEntry,
    listWorkspaceFiles,
    readWorkspaceFile,
    updateWorkspaceFile,
  },
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    onChange,
    value,
  }: {
    onChange: (value: string) => void;
    value: string;
  }) => (
    <textarea
      data-testid="mock-markdown-editor"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => (
    <div data-testid="mock-markdown-body">{children}</div>
  ),
}));

vi.mock("@/components/WorkspaceFilePreview", () => ({
  WorkspaceFilePreview: () => <div data-testid="mock-file-preview" />,
}));

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

function file(content = "hello"): OrganizationWorkspaceFileDetail {
  return {
    content,
    contentPath: null,
    contentType: "text/markdown",
    filePath: "reports/growth.md",
    libraryEntryId: "entry-a",
    markdownLink: null,
    mentionHref: null,
    message: null,
    previewKind: "text",
    repoUrl: null,
    rootExists: true,
    rootPath: "/tmp/workspace",
    source: "org_root",
    truncated: false,
  };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  window.sessionStorage.clear();
  getLibraryDocument.mockReset();
  getLibraryEntry.mockReset();
  listWorkspaceFiles.mockReset();
  readWorkspaceFile.mockReset();
  updateWorkspaceFile.mockReset();
  Reflect.deleteProperty(window, "desktopShell");
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  queryClient?.clear();
  host?.remove();
  host = null;
  root = null;
  queryClient = null;
  Reflect.deleteProperty(window, "desktopShell");
});

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient!}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

function FileHarness() {
  const [surface, setSurface] = useState<"side_panel" | "workbench">(
    "side_panel",
  );
  return (
    <>
      <button
        type="button"
        data-testid="move"
        onClick={() => setSurface("workbench")}
      >
        Move
      </button>
      <LibraryLiveSurface
        active
        organizationId="org-a"
        surface={surface}
        target={{
          kind: "library_file",
          filePath: "reports/growth.md",
          label: "growth.md",
          viewInstanceId: "view-file",
        }}
        onOpenTarget={() => undefined}
      />
    </>
  );
}

function renderFileHarness(initialFile = file()) {
  queryClient!.setQueryData(
    queryKeys.organizations.workspaceFile(
      "org-a",
      "reports/growth.md",
    ),
    initialFile,
  );
  act(() => {
    root!.render(
      <Providers>
        <FileHarness />
      </Providers>,
    );
  });
}

function changeEditor(editor: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(editor, value);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("LibraryLiveSurface", () => {
  it("keeps the exact editor owner and conditionally autosaves once after surface transfer", async () => {
    vi.useFakeTimers();
    updateWorkspaceFile.mockImplementation(
      async (
        _organizationId: string,
        _filePath: string,
        input: { content: string },
      ) => file(input.content),
    );
    renderFileHarness();

    const editor = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="mock-markdown-editor"]',
    )!;
    act(() => {
      changeEditor(editor, "hello world");
      host!.querySelector<HTMLButtonElement>('[data-testid="move"]')!.click();
    });
    expect(
      host!
        .querySelector<HTMLElement>('[data-testid="library-live-surface"]')
        ?.dataset.surface,
    ).toBe("workbench");
    expect(
      host!.querySelector('[data-testid="mock-markdown-editor"]'),
    ).toBe(editor);

    await act(async () => vi.advanceTimersByTimeAsync(700));

    expect(updateWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(updateWorkspaceFile).toHaveBeenCalledWith(
      "org-a",
      "reports/growth.md",
      {
        content: "hello world",
        expectedContent: "hello",
      },
    );
  });

  it("restores the file open selector on promoted Library file surfaces", async () => {
    const openWorkspaceFileInIde = vi.fn(async () => undefined);
    const openWorkspaceFileLocation = vi.fn(async () => undefined);
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        listWorkspaceLaunchTargets: vi.fn(async () => [
          { id: "cursor", label: "Cursor", kind: "ide" },
          { id: "finder", label: "Finder", kind: "folder" },
        ]),
        openWorkspaceFileInIde,
        openWorkspaceFileLocation,
      },
    });
    renderFileHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const selector = host!.querySelector<HTMLElement>(
      '[data-testid="library-live-surface-file-open-selector"]',
    );
    const toolbar = host!.querySelector<HTMLElement>(
      '[data-testid="library-live-surface-file-toolbar"]',
    );
    const trigger = selector?.querySelector<HTMLButtonElement>(
      'button[aria-label="Open file options"]',
    );
    expect(toolbar?.textContent).toContain("reports/growth.md");
    expect(toolbar?.contains(selector ?? null)).toBe(true);
    expect(selector?.classList.contains("absolute")).toBe(false);
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent(
        "pointerdown",
        { bubbles: true, cancelable: true, button: 0 },
      ));
      await Promise.resolve();
    });

    const cursorItem = document.body.querySelector<HTMLElement>(
      '[data-testid="library-live-surface-file-open-menu-target-cursor"]',
    );
    expect(document.body.textContent).toContain("Default app");
    expect(cursorItem?.textContent).toContain("Cursor");
    expect(document.body.textContent).toContain("Finder");

    await act(async () => {
      cursorItem?.click();
      await Promise.resolve();
    });
    expect(openWorkspaceFileInIde).toHaveBeenCalledWith(
      "/tmp/workspace",
      "reports/growth.md",
      "cursor",
    );
    expect(openWorkspaceFileLocation).not.toHaveBeenCalled();
  });

  it("reconciles a stale write into an isolated conflict instead of overwriting server content", async () => {
    vi.useFakeTimers();
    updateWorkspaceFile.mockRejectedValue(new Error("Precondition failed"));
    readWorkspaceFile.mockResolvedValue(file("server edit"));
    renderFileHarness();

    const editor = host!.querySelector<HTMLTextAreaElement>(
      '[data-testid="mock-markdown-editor"]',
    )!;
    act(() => {
      changeEditor(editor, "local edit");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host!.querySelector('[role="alert"]')?.textContent).toContain(
      "This file changed while you were editing it.",
    );
    expect(host!.textContent).toContain("Keep mine");
    expect(host!.textContent).toContain("Use latest");
  });

  it("does not let disabled document and entry queries keep a directory permanently pending", () => {
    const directory: OrganizationWorkspaceFileList = {
      directoryPath: "reports",
      entries: [{
        isDirectory: false,
        name: "growth.md",
        path: "reports/growth.md",
      }],
      message: null,
      repoUrl: null,
      rootExists: true,
      rootPath: "/tmp/workspace",
      source: "org_root",
    };
    queryClient!.setQueryData(
      queryKeys.organizations.workspaceFiles("org-a", "reports"),
      directory,
    );
    const opened: unknown[] = [];
    act(() => {
      root!.render(
        <Providers>
          <LibraryLiveSurface
            active
            organizationId="org-a"
            surface="workbench"
            target={{
              kind: "library_directory",
              directoryPath: "reports",
              label: "Reports",
              viewInstanceId: "view-directory",
            }}
            onOpenTarget={(target) => opened.push(target)}
          />
        </Providers>,
      );
    });

    expect(
      host!.querySelector('[data-testid="library-live-surface-loading"]'),
    ).toBeNull();
    act(() => {
      host!.querySelector<HTMLButtonElement>("li button")!.click();
    });
    expect(opened).toEqual([{
      filePath: "reports/growth.md",
      kind: "library_file",
      label: "growth.md",
    }]);
  });

  it("renders legacy Library documents as a read-only workbench surface", () => {
    queryClient!.setQueryData(
      queryKeys.organizations.libraryDocument("org-a", "document-a"),
      {
        body: "# Launch brief",
        createdAt: new Date(),
        createdByAgentId: null,
        createdByUserId: "user-a",
        format: "markdown",
        id: "document-a",
        latestRevisionId: null,
        latestRevisionNumber: 1,
        orgId: "org-a",
        title: "Launch brief",
        updatedAt: new Date(),
        updatedByAgentId: null,
        updatedByUserId: "user-a",
      },
    );
    act(() => {
      root!.render(
        <Providers>
          <LibraryLiveSurface
            active
            organizationId="org-a"
            surface="workbench"
            target={{
              kind: "library_document",
              documentId: "document-a",
              label: "Launch brief",
              viewInstanceId: "view-document",
            }}
            onOpenTarget={() => undefined}
          />
        </Providers>,
      );
    });

    expect(
      host!.querySelector('[data-testid="mock-markdown-body"]')?.textContent,
    ).toBe("# Launch brief");
    expect(
      host!.querySelector('[data-testid="mock-markdown-editor"]'),
    ).toBeNull();
  });
});
