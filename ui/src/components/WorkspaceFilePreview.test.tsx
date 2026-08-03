// @vitest-environment jsdom

import type {
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceWebPreviewSession,
} from "@rudderhq/shared";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePreviewProvider } from "../context/ImagePreviewContext";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { createWorkspaceWebPreviewSession } = vi.hoisted(() => ({
  createWorkspaceWebPreviewSession: vi.fn(),
}));

vi.mock("../api/orgs", () => ({
  organizationsApi: { createWorkspaceWebPreviewSession },
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: string; className?: string }) => (
    <div className={className} data-testid="mock-markdown">{children}</div>
  ),
}));

vi.mock("./WorkspaceCodeEditor", () => ({
  WorkspaceCodeEditor: ({
    "data-testid": testId,
    filePath,
    readOnly,
    value,
  }: {
    "data-testid"?: string;
    filePath: string | null;
    readOnly?: boolean;
    value: string;
  }) => (
    <pre data-testid={testId} data-file-path={filePath} data-read-only={readOnly ? "true" : "false"}>
      {value}
    </pre>
  ),
}));

vi.mock("./WorkspacePdfPreview", () => ({
  WorkspacePdfPreview: ({ src, testId, title }: { src: string; testId: string; title: string }) => (
    <canvas aria-label={title} data-pdf-src={src} data-testid={testId} />
  ),
}));

const roots: Root[] = [];

function workspaceFile(
  overrides: Partial<OrganizationWorkspaceFileDetail>,
): OrganizationWorkspaceFileDetail {
  return {
    source: "org_root",
    rootPath: "/tmp/library",
    repoUrl: null,
    filePath: "reports/data.json",
    libraryEntryId: "entry-1",
    mentionHref: null,
    markdownLink: null,
    rootExists: true,
    content: "{}",
    contentType: "application/json",
    previewKind: "text",
    contentPath: null,
    message: null,
    truncated: false,
    ...overrides,
  };
}

async function renderPreview(
  file: OrganizationWorkspaceFileDetail,
  mode: "preview" | "source" = "preview",
  onModeChange = vi.fn(),
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  createWorkspaceWebPreviewSession.mockResolvedValue({
    previewUrl: "http://preview.localhost:3100/workspace-preview/test-token/report.html",
    networkMode: "connected",
    expiresAt: "2026-07-15T12:00:00.000Z",
  });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ImagePreviewProvider>
          <WorkspaceFilePreview
            file={file}
            organizationId="org-1"
            mode={mode}
            onModeChange={onModeChange}
            htmlOpenAction={<button type="button" data-testid="test-file-open">Open</button>}
            mediaOpenAction={<button type="button" data-testid="test-media-open">Open media</button>}
            testIdPrefix="test-file"
          />
        </ImagePreviewProvider>
      </MemoryRouter>,
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

describe("WorkspaceFilePreview", () => {
  it("renders Markdown as an unframed document surface", async () => {
    const container = await renderPreview(workspaceFile({
      filePath: "reports/report.md",
      content: "# Rendered report",
      contentType: "text/markdown",
    }));

    expect(container.querySelector("[data-testid='test-file-markdown-preview']")).not.toBeNull();
    const markdown = container.querySelector("[data-testid='mock-markdown']");
    expect(markdown?.textContent).toContain("Rendered report");
    expect(markdown?.classList.contains("rudder-readable-document")).toBe(true);
  });

  it("renders HTML by default and keeps a read-only source mode", async () => {
    const file = workspaceFile({
      filePath: "reports/report.html",
      content: "<!doctype html><html><body><h1>Rendered report</h1></body></html>",
      contentType: "text/html",
    });
    const onModeChange = vi.fn();
    const previewContainer = await renderPreview(file, "preview", onModeChange);
    const preview = previewContainer.querySelector<HTMLIFrameElement>("[data-testid='test-file-html-preview']");
    const toolbar = previewContainer.querySelector<HTMLElement>("[data-testid='test-file-html-preview-toolbar']");

    expect(preview?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(preview?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(preview?.getAttribute("src")).toContain("preview.localhost:3100/workspace-preview/");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector("[role='group'][aria-label='HTML file mode']")).not.toBeNull();
    expect(toolbar?.querySelector("[data-testid='test-file-open']")).not.toBeNull();
    const connectedMenu = toolbar?.querySelector<HTMLButtonElement>("[data-testid='test-file-html-preview-network-menu']");
    expect(connectedMenu?.textContent).toContain("Connected");
    expect(connectedMenu?.getAttribute("aria-label")).toContain("may send preview content");
    const sourceButton = Array.from(toolbar?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent === "Source");
    await act(async () => sourceButton?.click());
    expect(onModeChange).toHaveBeenCalledWith("source");
    expect(createWorkspaceWebPreviewSession).toHaveBeenCalledWith("org-1", {
      entryPath: "reports/report.html",
      networkMode: "connected",
      htmlContent: file.content,
    });

    const sourceContainer = await renderPreview(file, "source");
    const source = sourceContainer.querySelector("[data-testid='test-file-code-preview']");
    expect(source?.getAttribute("data-read-only")).toBe("true");
    expect(source?.textContent).toContain("Rendered report");
    expect(sourceContainer.querySelector("[data-testid='test-file-html-preview-toolbar']")).not.toBeNull();
    expect(sourceContainer.querySelector("[data-testid='test-file-html-preview-network-menu']")).toBeNull();
    expect(sourceContainer.querySelector("[data-testid='test-file-open']")).not.toBeNull();
  });

  it("creates a new Offline session after explicit selection", async () => {
    const file = workspaceFile({
      filePath: "reports/report.html",
      content: "<!doctype html><html><body><script src=\"script.js\"></script></body></html>",
      contentType: "text/html",
    });
    const container = await renderPreview(file);
    createWorkspaceWebPreviewSession.mockResolvedValueOnce({
      previewUrl: "http://preview.localhost:3100/workspace-preview/offline-token/report.html",
      networkMode: "offline",
      expiresAt: "2026-07-15T12:00:00.000Z",
    });

    const networkMenu = container.querySelector<HTMLButtonElement>(
      "[data-testid='test-file-html-preview-network-menu']",
    );
    await act(async () => {
      networkMenu?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    const offlineItem = Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitemradio']"))
      .find((item) => item.textContent?.includes("Offline"));
    await act(async () => {
      offlineItem?.click();
      await Promise.resolve();
    });

    const preview = container.querySelector<HTMLIFrameElement>("[data-testid='test-file-html-preview']");
    expect(preview?.getAttribute("sandbox")).toBe("");
    expect(preview?.getAttribute("src")).toContain("offline-token");
    expect(createWorkspaceWebPreviewSession).toHaveBeenLastCalledWith("org-1", {
      entryPath: "reports/report.html",
      networkMode: "offline",
      htmlContent: file.content,
    });
  });

  it("resets to Connected whenever another HTML file becomes active", async () => {
    const firstFile = workspaceFile({
      filePath: "reports/first.html",
      content: "<!doctype html><h1>First</h1>",
      contentType: "text/html",
    });
    const secondFile = workspaceFile({
      filePath: "reports/second.html",
      content: "<!doctype html><h1>Second</h1>",
      contentType: "text/html",
    });
    createWorkspaceWebPreviewSession.mockImplementation(async (_organizationId, request) => ({
      previewUrl: `http://preview.localhost:3100/workspace-preview/${request.networkMode}/${request.entryPath}`,
      networkMode: request.networkMode,
      expiresAt: "2026-07-15T12:00:00.000Z",
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const renderFile = async (file: OrganizationWorkspaceFileDetail) => {
      await act(async () => {
        root.render(
          <WorkspaceFilePreview
            file={file}
            organizationId="org-1"
            mode="preview"
            testIdPrefix="identity-file"
          />,
        );
      });
    };

    await renderFile(firstFile);
    const networkMenu = container.querySelector<HTMLButtonElement>(
      "[data-testid='identity-file-html-preview-network-menu']",
    );
    await act(async () => {
      networkMenu?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    const offlineItem = Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitemradio']"))
      .find((item) => item.textContent?.includes("Offline"));
    await act(async () => {
      offlineItem?.click();
      await Promise.resolve();
    });
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("");

    await renderFile(secondFile);
    expect(createWorkspaceWebPreviewSession).toHaveBeenLastCalledWith("org-1", {
      entryPath: secondFile.filePath,
      networkMode: "connected",
      htmlContent: secondFile.content,
    });
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");

    await renderFile(firstFile);
    expect(createWorkspaceWebPreviewSession).toHaveBeenLastCalledWith("org-1", {
      entryPath: firstFile.filePath,
      networkMode: "connected",
      htmlContent: firstFile.content,
    });
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("falls back to a static Offline document when the preview runtime is unavailable", async () => {
    const file = workspaceFile({
      filePath: "reports/report.html",
      content: "<!-- <head> --><h1>Static fallback</h1><script>window.parent.document.body.dataset.leaked = 'yes'</script>",
      contentType: "text/html",
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    createWorkspaceWebPreviewSession.mockRejectedValue(new Error("Stable file verification is unavailable."));

    await act(async () => {
      root.render(
        <WorkspaceFilePreview
          file={file}
          organizationId="org-1"
          mode="preview"
          testIdPrefix="fallback-file"
        />,
      );
    });

    const fallback = container.querySelector<HTMLIFrameElement>("[data-testid='fallback-file-html-preview']");
    expect(container.querySelector("[role='alert']")?.textContent).toContain("static Offline document");
    expect(fallback?.getAttribute("data-preview-fallback")).toBe("static");
    expect(fallback?.getAttribute("sandbox")).toBe("");
    expect(fallback?.getAttribute("srcdoc")).toContain("script-src 'none'");
    expect(fallback?.getAttribute("srcdoc")?.indexOf("Content-Security-Policy"))
      .toBeLessThan(fallback?.getAttribute("srcdoc")?.indexOf("<h1>Static fallback</h1>") ?? 0);
    const networkMenu = container.querySelector<HTMLButtonElement>(
      "[data-testid='fallback-file-html-preview-network-menu']",
    );
    expect(networkMenu?.textContent).toContain("Offline");
    expect(networkMenu?.getAttribute("aria-label")).toContain("Connected preview is unavailable");
    expect(networkMenu?.disabled).toBe(true);
  });

  it("deduplicates the initial preview session request in React StrictMode", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    let resolveSession: ((session: OrganizationWorkspaceWebPreviewSession) => void) | undefined;
    createWorkspaceWebPreviewSession.mockReturnValue(new Promise((resolve) => {
      resolveSession = resolve;
    }));

    await act(async () => {
      root.render(
        <StrictMode>
          <WorkspaceFilePreview
            file={workspaceFile({
              filePath: "reports/strict.html",
              content: "<!doctype html><h1>Strict preview</h1>",
              contentType: "text/html",
            })}
            organizationId="org-1"
            mode="preview"
            testIdPrefix="strict-file"
          />
        </StrictMode>,
      );
    });

    expect(createWorkspaceWebPreviewSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSession?.({
        previewUrl: "http://preview.localhost:3100/workspace-preview/strict-token/strict.html",
        networkMode: "connected",
        expiresAt: "2026-07-15T12:00:00.000Z",
      });
    });
    expect(container.querySelector("[data-testid='strict-file-html-preview']")).not.toBeNull();
  });

  it("renders CSV as a semantic table and keeps a source mode", async () => {
    const file = workspaceFile({
      filePath: "reports/data.csv",
      content: "keyword,count\nagent,12\norchestration,8\n",
      contentType: "text/csv",
    });
    const previewContainer = await renderPreview(file);
    const table = previewContainer.querySelector("table[aria-label='CSV preview table']");

    expect(table).not.toBeNull();
    expect(table?.textContent).toContain("keyword");
    expect(table?.textContent).toContain("orchestration");

    const sourceContainer = await renderPreview(file, "source");
    expect(sourceContainer.querySelector("[data-testid='test-file-code-preview']")?.textContent)
      .toContain("keyword,count");
  });

  it("caps large CSV table DOM and tells the operator how to inspect the rest", async () => {
    const rows = Array.from({ length: 505 }, (_, index) => `${index},keyword-${index}`);
    const container = await renderPreview(workspaceFile({
      filePath: "reports/large.csv",
      content: ["rank,keyword", ...rows].join("\n"),
      contentType: "text/csv",
    }));

    expect(container.querySelectorAll("tbody tr")).toHaveLength(500);
    expect(container.querySelector("[role='status']")?.textContent).toContain("5 more data rows");
  });

  it("keeps production-sized CSV previews within the bounded table surface", async () => {
    const rows = Array.from({ length: 150_000 }, (_, index) => `${index},keyword-${index}`);
    const container = await renderPreview(workspaceFile({
      filePath: "reports/production.csv",
      content: ["rank,keyword", ...rows].join("\n"),
      contentType: "text/csv",
    }));

    expect(container.querySelectorAll("tbody tr")).toHaveLength(500);
    expect(container.querySelector("[role='status']")?.textContent).toContain("149,500 more data rows");
  });

  it("caps malformed ultra-wide CSV previews before normalizing table rows", async () => {
    const columns = Array.from({ length: 10_000 }, (_, index) => `column-${index}`);
    const rows = Array.from({ length: 505 }, (_, index) => `row-${index}`);
    const container = await renderPreview(workspaceFile({
      filePath: "reports/ultra-wide.csv",
      content: [columns.join(","), ...rows].join("\n"),
      contentType: "text/csv",
    }));

    expect(container.querySelectorAll("thead th")).toHaveLength(101);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(500);
    expect(container.querySelectorAll("tbody td")).toHaveLength(50_000);
    expect(container.querySelector("[role='status']")?.textContent).toContain("9,900 more columns");
  });

  it("renders JSON and plain text in the full read-only code surface", async () => {
    const jsonContainer = await renderPreview(workspaceFile({ content: "{\"ready\":true}" }));
    const jsonPreview = jsonContainer.querySelector("[data-testid='test-file-code-preview']");
    expect(jsonPreview?.getAttribute("data-read-only")).toBe("true");
    expect(jsonPreview?.textContent).toContain("ready");

    const textContainer = await renderPreview(workspaceFile({
      filePath: "reports/notes.txt",
      content: "Full-width notes",
      contentType: "text/plain",
    }));
    expect(textContainer.querySelector("[data-testid='test-file-code-preview']")?.textContent)
      .toContain("Full-width notes");
  });

  it("renders image and PDF assets directly in their preview surfaces", async () => {
    const imageContainer = await renderPreview(workspaceFile({
      filePath: "reports/chart.png",
      content: null,
      contentType: "image/png",
      previewKind: "image",
      contentPath: "/api/image",
    }));
    expect(imageContainer.querySelector("[data-testid='test-file-image-preview']")?.getAttribute("src"))
      .toBe("/api/image");
    await act(async () => {
      imageContainer.querySelector<HTMLButtonElement>(".rudder-inspectable-image-trigger")?.click();
    });
    expect(document.body.querySelector("[data-testid='test-file-image-preview-dialog']"))
      .not.toBeNull();

    const pdfContainer = await renderPreview(workspaceFile({
      filePath: "reports/report.pdf",
      content: null,
      contentType: "application/pdf",
      previewKind: "pdf",
      contentPath: "/api/report.pdf",
    }));
    const pdfPreview = pdfContainer.querySelector<HTMLCanvasElement>("[data-testid='test-file-pdf-preview']");
    expect(pdfPreview?.tagName).toBe("CANVAS");
    expect(pdfPreview?.getAttribute("data-pdf-src")).toBe("/api/report.pdf");
    expect(pdfPreview?.getAttribute("aria-label")).toBe("reports/report.pdf");
  });

  it.each([
    ["video", "reports/demo.mp4", "video/mp4", "VIDEO"],
    ["audio", "reports/demo.mp3", "audio/mpeg", "AUDIO"],
  ] as const)("delegates %s files to the shared media renderer", async (previewKind, filePath, contentType, tagName) => {
    const contentPath = `/api/orgs/org-1/workspace/file/content?path=${encodeURIComponent(filePath)}`;
    const container = await renderPreview(workspaceFile({
      filePath,
      content: null,
      contentType,
      previewKind,
      contentPath,
    }));

    const preview = container.querySelector<HTMLElement>(`[data-testid='test-file-${previewKind}-preview']`);
    expect(preview?.tagName).toBe(tagName);
    expect(preview?.getAttribute("src")).toBe(contentPath);
    expect(container.querySelector(`[data-workspace-media-preview='${previewKind}']`)).not.toBeNull();
    expect(container.querySelector("[data-testid='test-media-open']")).not.toBeNull();
  });

  it("shows an explicit fallback for unsupported binary files", async () => {
    const container = await renderPreview(workspaceFile({
      filePath: "reports/archive.zip",
      content: null,
      contentType: "application/zip",
      previewKind: "binary",
      message: "Binary files cannot be previewed.",
    }));

    expect(container.querySelector("[data-testid='test-file-preview-unavailable']")?.textContent)
      .toContain("Binary files cannot be previewed.");
  });
});
