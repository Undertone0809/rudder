// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptLocalFilePreview } from "./TranscriptLocalFilePreview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  listWorkspaceLaunchTargets,
  openPath,
  openWorkspaceFileInIde,
  openWorkspaceFileLocation,
  previewLocalFile,
  readDesktopShell,
  updateLocalFile,
} = vi.hoisted(() => ({
  listWorkspaceLaunchTargets: vi.fn(),
  openPath: vi.fn(),
  openWorkspaceFileInIde: vi.fn(),
  openWorkspaceFileLocation: vi.fn(),
  previewLocalFile: vi.fn(),
  readDesktopShell: vi.fn(),
  updateLocalFile: vi.fn(),
}));

vi.mock("../../lib/desktop-shell", () => ({ readDesktopShell }));
vi.mock("../WorkspaceFilePreview", () => ({
  WorkspaceFilePreview: ({ file }: { file: { filePath: string; content: string | null } }) => (
    <pre data-testid="local-file-rendered-preview" data-file-path={file.filePath}>{file.content}</pre>
  ),
}));
vi.mock("../MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      data-testid="local-file-rendered-preview"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));
vi.mock("../WorkspaceCodeEditor", () => ({
  WorkspaceCodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      data-testid="local-file-code-editor"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

const roots: Root[] = [];

async function renderPreview() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <TranscriptLocalFilePreview targetPath="/tmp/evidence.md" label="evidence.md" />
      </StrictMode>,
    );
  });
  return container;
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("TranscriptLocalFilePreview", () => {
  it("loads a safe Desktop preview and keeps the canonical path as evidence", async () => {
    readDesktopShell.mockReturnValue({ openPath, previewLocalFile, updateLocalFile });
    previewLocalFile.mockResolvedValue({
      canonicalPath: "/private/tmp/evidence.md",
      fileName: "evidence.md",
      parentPath: "/private/tmp",
      contentType: "text/markdown; charset=utf-8",
      previewKind: "markdown",
      content: "# Evidence",
      base64: null,
      sizeBytes: 10,
      modifiedAt: "2026-07-21T00:00:00.000Z",
      truncated: false,
      writeCapability: "preview-capability",
    });

    const container = await renderPreview();

    expect(previewLocalFile).toHaveBeenCalledWith("/tmp/evidence.md");
    expect(previewLocalFile).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='local-file-rendered-preview']")?.textContent).toContain("Evidence");
    expect(container.textContent).not.toContain("/private/tmp");
    expect(container.querySelector("[data-testid='chat-side-panel-local-file-view'] [title='/private/tmp/evidence.md']")?.textContent)
      .toBe("evidence.md");
  });

  it("offers the installed Desktop open targets for a local transcript file", async () => {
    readDesktopShell.mockReturnValue({
      listWorkspaceLaunchTargets,
      openPath,
      openWorkspaceFileInIde,
      openWorkspaceFileLocation,
      previewLocalFile,
      updateLocalFile,
    });
    listWorkspaceLaunchTargets.mockResolvedValue([
      { id: "cursor", label: "Cursor", kind: "ide" },
      { id: "vscode", label: "VS Code", kind: "ide" },
      { id: "terminal", label: "Terminal", kind: "terminal" },
      { id: "finder", label: "Finder", kind: "folder" },
    ]);
    previewLocalFile.mockResolvedValue({
      canonicalPath: "/private/tmp/evidence.md",
      fileName: "evidence.md",
      parentPath: "/private/tmp",
      contentType: "text/markdown; charset=utf-8",
      previewKind: "markdown",
      content: "# Evidence",
      base64: null,
      sizeBytes: 10,
      modifiedAt: "2026-07-21T00:00:00.000Z",
      truncated: false,
      writeCapability: "preview-capability",
    });

    const container = await renderPreview();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      "[data-testid='chat-side-panel-local-file-open-menu']",
    );
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const menuItems = Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem']"));
    expect(menuItems.map((item) => item.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining("Default app"),
      expect.stringContaining("Cursor"),
      expect.stringContaining("VS Code"),
      expect.stringContaining("Terminal"),
      expect.stringContaining("Finder"),
    ]));

    await act(async () => {
      menuItems.find((item) => item.textContent?.includes("Default app"))?.click();
      await Promise.resolve();
    });
    expect(openPath).toHaveBeenCalledWith("/private/tmp/evidence.md");

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    const reopenedMenuItems = Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem']"));
    await act(async () => {
      reopenedMenuItems.find((item) => item.textContent?.includes("Cursor"))?.click();
      await Promise.resolve();
    });
    expect(openWorkspaceFileInIde).toHaveBeenCalledWith("/private/tmp", "evidence.md", "cursor");

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
      Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem']"))
        .find((item) => item.textContent?.includes("Terminal"))
        ?.click();
      await Promise.resolve();
    });
    expect(openWorkspaceFileLocation).toHaveBeenCalledWith("/private/tmp", "evidence.md", "terminal");
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["without target discovery", undefined],
    ["when target discovery fails", new Error("target discovery unavailable")],
  ])("keeps the legacy Open action %s", async (_label, discoveryError) => {
    readDesktopShell.mockReturnValue({
      ...(discoveryError ? { listWorkspaceLaunchTargets } : {}),
      openPath,
      openWorkspaceFileInIde,
      previewLocalFile,
      updateLocalFile,
    });
    if (discoveryError) listWorkspaceLaunchTargets.mockRejectedValue(discoveryError);
    previewLocalFile.mockResolvedValue({
      canonicalPath: "/private/tmp/evidence.md",
      fileName: "evidence.md",
      parentPath: "/private/tmp",
      contentType: "text/markdown; charset=utf-8",
      previewKind: "markdown",
      content: "# Evidence",
      base64: null,
      sizeBytes: 10,
      modifiedAt: "2026-07-21T00:00:00.000Z",
      truncated: false,
      writeCapability: "preview-capability",
    });

    const container = await renderPreview();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='chat-side-panel-local-file-open-menu']")).toBeNull();
    const openButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Open"));
    expect(openButton).not.toBeUndefined();
    await act(async () => {
      openButton?.click();
      await Promise.resolve();
    });
    expect(openPath).toHaveBeenCalledWith("/private/tmp/evidence.md");
  });

  it("conditionally saves an edited local Markdown file", async () => {
    vi.useFakeTimers();
    const initial = {
      canonicalPath: "/private/tmp/evidence.md",
      fileName: "evidence.md",
      parentPath: "/private/tmp",
      contentType: "text/markdown; charset=utf-8",
      previewKind: "markdown",
      content: "# Evidence",
      base64: null,
      sizeBytes: 10,
      modifiedAt: "2026-07-21T00:00:00.000Z",
      truncated: false,
      writeCapability: "preview-capability",
    };
    readDesktopShell.mockReturnValue({ openPath, previewLocalFile, updateLocalFile });
    previewLocalFile.mockResolvedValue(initial);
    updateLocalFile.mockResolvedValue({ ...initial, content: "# Revised", sizeBytes: 9 });
    const container = await renderPreview();
    const editor = container.querySelector<HTMLTextAreaElement>("[data-testid='local-file-rendered-preview']")!;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        editor,
        "# Revised",
      );
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(700);
    });

    expect(updateLocalFile).toHaveBeenCalledWith("/private/tmp/evidence.md", {
      content: "# Revised",
      expectedContent: "# Evidence",
      writeCapability: "preview-capability",
    });
    expect(container.textContent).toContain("Saved");
  });

  it("shows an explicit Desktop fallback on the web", async () => {
    readDesktopShell.mockReturnValue(null);

    const container = await renderPreview();

    expect(container.querySelector("[role='alert']")?.textContent).toContain("Rudder Desktop");
    expect(previewLocalFile).not.toHaveBeenCalled();
  });

  it("explains that a missing historical target may have lost its command working directory", async () => {
    readDesktopShell.mockReturnValue({ openPath, previewLocalFile, updateLocalFile });
    previewLocalFile.mockRejectedValue(
      new Error("ENOENT: no such file or directory, realpath '/wrong/workspace/evidence.md'"),
    );

    const container = await renderPreview();

    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Could not resolve the file location recorded by this run.",
    );
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "older transcript may not include the command's original working directory",
    );
    expect(container.textContent).not.toContain("/wrong/workspace");
  });

  it("surfaces an operating-system open failure instead of leaving an unhandled rejection", async () => {
    readDesktopShell.mockReturnValue({ openPath, previewLocalFile, updateLocalFile });
    previewLocalFile.mockResolvedValue({
      canonicalPath: "/private/tmp/evidence.md",
      fileName: "evidence.md",
      parentPath: "/private/tmp",
      contentType: "text/markdown; charset=utf-8",
      previewKind: "markdown",
      content: "# Evidence",
      base64: null,
      sizeBytes: 10,
      modifiedAt: "2026-07-21T00:00:00.000Z",
      truncated: false,
      writeCapability: "preview-capability",
    });
    openPath.mockRejectedValue(new Error("No application can open this file."));

    const container = await renderPreview();
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
    });

    expect(openPath).toHaveBeenCalledWith("/private/tmp/evidence.md");
    expect(container.querySelector("[role='alert']")?.textContent).toContain("No application");
  });
});
