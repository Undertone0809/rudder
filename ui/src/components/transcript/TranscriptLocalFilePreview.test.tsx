// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptLocalFilePreview } from "./TranscriptLocalFilePreview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { openPath, previewLocalFile, readDesktopShell } = vi.hoisted(() => ({
  openPath: vi.fn(),
  previewLocalFile: vi.fn(),
  readDesktopShell: vi.fn(),
}));

vi.mock("../../lib/desktop-shell", () => ({ readDesktopShell }));
vi.mock("../WorkspaceFilePreview", () => ({
  WorkspaceFilePreview: ({ file }: { file: { filePath: string; content: string | null } }) => (
    <pre data-testid="local-file-rendered-preview" data-file-path={file.filePath}>{file.content}</pre>
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
});

describe("TranscriptLocalFilePreview", () => {
  it("loads a safe Desktop preview and keeps the canonical path as evidence", async () => {
    readDesktopShell.mockReturnValue({ openPath, previewLocalFile });
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
    });

    const container = await renderPreview();

    expect(previewLocalFile).toHaveBeenCalledWith("/tmp/evidence.md");
    expect(previewLocalFile).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='local-file-rendered-preview']")?.textContent).toContain("Evidence");
    expect(container.textContent).not.toContain("/private/tmp");
    expect(container.querySelector("[data-testid='chat-side-panel-local-file-view'] [title='/private/tmp/evidence.md']")?.textContent)
      .toBe("evidence.md");
  });

  it("shows an explicit Desktop fallback on the web", async () => {
    readDesktopShell.mockReturnValue(null);

    const container = await renderPreview();

    expect(container.querySelector("[role='alert']")?.textContent).toContain("Rudder Desktop");
    expect(previewLocalFile).not.toHaveBeenCalled();
  });

  it("surfaces an operating-system open failure instead of leaving an unhandled rejection", async () => {
    readDesktopShell.mockReturnValue({ openPath, previewLocalFile });
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
