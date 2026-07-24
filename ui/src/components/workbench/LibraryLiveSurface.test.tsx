// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryLiveSurface } from "./LibraryLiveSurface";

const api = vi.hoisted(() => ({
  readWorkspaceFile: vi.fn(),
  updateWorkspaceFile: vi.fn(),
}));
const editorState = vi.hoisted(() => ({
  engine: null as string | null,
}));

vi.mock("@/api/orgs", () => ({
  organizationsApi: {
    getLibraryDocument: vi.fn(),
    getLibraryEntry: vi.fn(),
    listWorkspaceFiles: vi.fn(),
    readWorkspaceFile: api.readWorkspaceFile,
    updateWorkspaceFile: api.updateWorkspaceFile,
  },
}));

vi.mock("@/components/MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef(function MarkdownEditor(
      props: {
        engine?: string;
        onChange: (value: string) => void;
        value: string;
      },
      ref: React.ForwardedRef<{
        canRedo: () => boolean;
        canUndo: () => boolean;
        redo: () => void;
        undo: () => void;
      }>,
    ) {
      editorState.engine = props.engine ?? null;
      React.useImperativeHandle(ref, () => ({
        canRedo: () => false,
        canUndo: () => false,
        redo: () => undefined,
        undo: () => undefined,
      }));
      return (
        <textarea
          data-testid="markdown-input"
          value={props.value}
          onChange={(event) => props.onChange(event.currentTarget.value)}
        />
      );
    }),
  };
});

vi.mock("@/components/WorkspaceFilePreview", () => ({
  isWorkspaceMarkdownPreviewFile: (file: { filePath: string }) => (
    file.filePath.endsWith(".md")
  ),
  WorkspaceFilePreview: () => <div data-testid="workspace-preview" />,
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("LibraryLiveSurface", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    sessionStorage.clear();
    api.readWorkspaceFile.mockReset();
    api.updateWorkspaceFile.mockReset();
    api.readWorkspaceFile.mockResolvedValue({
      content: "hello",
      contentPath: null,
      contentType: "text/markdown",
      filePath: "README.md",
      previewKind: "text",
      rootPath: "/tmp/workspace",
      truncated: false,
    });
    api.updateWorkspaceFile.mockImplementation(async (
      _organizationId: string,
      _filePath: string,
      input: { content: string },
    ) => ({
      content: input.content,
      contentPath: null,
      contentType: "text/markdown",
      filePath: "README.md",
      previewKind: "text",
      rootPath: "/tmp/workspace",
      truncated: false,
    }));
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    host.remove();
    vi.useRealTimers();
  });

  it("keeps the exact editor draft and one conditional autosave owner when its surface changes", async () => {
    const target = {
      kind: "library_file" as const,
      filePath: "README.md",
      label: "README",
      viewInstanceId: "library-view",
    };
    const render = (surface: "side_panel" | "workbench") => act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LibraryLiveSurface
            active
            organizationId="org-a"
            surface={surface}
            target={target}
            onOpenTarget={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    render("side_panel");
    await act(async () => {
      await vi.waitFor(() => {
        expect(
          host.querySelector<HTMLTextAreaElement>('[data-testid="markdown-input"]')?.value,
        ).toBe("hello");
      });
    });
    const editor = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="markdown-input"]',
    )!;
    vi.useFakeTimers();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      valueSetter.call(editor, "hello world");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    render("workbench");
    expect(
      host.querySelector('[data-testid="markdown-input"]'),
    ).toBe(editor);
    expect(editor.value).toBe("hello world");
    expect(editorState.engine).toBe("codemirror");
    expect(
      host.querySelector('[data-testid="library-live-surface"]')
        ?.getAttribute("data-library-surface"),
    ).toBe("workbench");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    expect(api.updateWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(api.updateWorkspaceFile).toHaveBeenCalledWith(
      "org-a",
      "README.md",
      {
        content: "hello world",
        expectedContent: "hello",
      },
    );
  });

  it("does not carry a dirty in-flight session into another Library target", async () => {
    api.readWorkspaceFile.mockImplementation(async (
      _organizationId: string,
      filePath: string,
    ) => ({
      content: filePath === "A.md" ? "alpha" : "bravo",
      contentPath: null,
      contentType: "text/markdown",
      filePath,
      previewKind: "text",
      rootPath: "/tmp/workspace",
      truncated: false,
    }));
    let resolveFirstSave!: (detail: {
      content: string;
      contentPath: null;
      contentType: string;
      filePath: string;
      previewKind: string;
      rootPath: string;
      truncated: boolean;
    }) => void;
    api.updateWorkspaceFile.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirstSave = resolve;
    }));
    const render = (filePath: string) => act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LibraryLiveSurface
            active
            organizationId="org-a"
            surface="workbench"
            target={{
              kind: "library_file",
              filePath,
              label: filePath,
              viewInstanceId: `library-${filePath}`,
            }}
            onOpenTarget={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    render("A.md");
    await act(async () => {
      await vi.waitFor(() => {
        expect(host.querySelector<HTMLTextAreaElement>('[data-testid="markdown-input"]')?.value)
          .toBe("alpha");
      });
    });
    const firstEditor = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="markdown-input"]',
    )!;
    vi.useFakeTimers();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      valueSetter.call(firstEditor, "alpha local");
      firstEditor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(api.updateWorkspaceFile).toHaveBeenCalledWith(
      "org-a",
      "A.md",
      { content: "alpha local", expectedContent: "alpha" },
    );
    vi.useRealTimers();

    render("B.md");
    await act(async () => {
      await vi.waitFor(() => {
        expect(host.querySelector<HTMLTextAreaElement>('[data-testid="markdown-input"]')?.value)
          .toBe("bravo");
      });
    });
    const secondEditor = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="markdown-input"]',
    )!;
    expect(secondEditor).not.toBe(firstEditor);

    resolveFirstSave({
      content: "alpha local",
      contentPath: null,
      contentType: "text/markdown",
      filePath: "A.md",
      previewKind: "text",
      rootPath: "/tmp/workspace",
      truncated: false,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(secondEditor.value).toBe("bravo");
    expect(host.textContent).not.toContain("Conflict");
  });
});
