// @vitest-environment jsdom

import type { OrganizationWorkspaceFileDetail } from "@rudderhq/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="mock-markdown">{children}</div>,
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
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<WorkspaceFilePreview file={file} mode={mode} testIdPrefix="test-file" />);
  });
  return container;
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe("WorkspaceFilePreview", () => {
  it("renders Markdown as an unframed document surface", async () => {
    const container = await renderPreview(workspaceFile({
      filePath: "reports/report.md",
      content: "# Rendered report",
      contentType: "text/markdown",
    }));

    expect(container.querySelector("[data-testid='test-file-markdown-preview']")).not.toBeNull();
    expect(container.querySelector("[data-testid='mock-markdown']")?.textContent).toContain("Rendered report");
  });

  it("renders HTML by default and keeps a read-only source mode", async () => {
    const file = workspaceFile({
      filePath: "reports/report.html",
      content: "<!doctype html><html><body><h1>Rendered report</h1></body></html>",
      contentType: "text/html",
    });
    const previewContainer = await renderPreview(file);
    const preview = previewContainer.querySelector<HTMLIFrameElement>("[data-testid='test-file-html-preview']");

    expect(preview?.getAttribute("sandbox")).toBe("");
    expect(preview?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(preview?.getAttribute("srcdoc")).toContain("Content-Security-Policy");

    const sourceContainer = await renderPreview(file, "source");
    const source = sourceContainer.querySelector("[data-testid='test-file-code-preview']");
    expect(source?.getAttribute("data-read-only")).toBe("true");
    expect(source?.textContent).toContain("Rendered report");
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
