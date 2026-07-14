import type { OrganizationWorkspaceFileDetail } from "@rudderhq/shared";
import { normalizeWorkspaceCsvRows, parseWorkspaceCsvContent } from "../lib/workspace-csv";
import {
  buildWorkspaceHtmlPreviewSrcDoc,
  isWorkspaceHtmlContentType,
  isWorkspaceHtmlFilePath,
} from "../lib/workspace-html-preview";
import { MarkdownBody } from "./MarkdownBody";
import { WorkspaceCodeEditor } from "./WorkspaceCodeEditor";
import { WorkspacePdfPreview } from "./WorkspacePdfPreview";

const WORKSPACE_MARKDOWN_FILE_EXTENSIONS = [".md", ".markdown", ".mdown", ".mdx"];
const WORKSPACE_CSV_FILE_EXTENSIONS = [".csv"];
const WORKSPACE_CSV_PREVIEW_ROW_LIMIT = 500;
const WORKSPACE_CSV_PREVIEW_COLUMN_LIMIT = 100;

export type WorkspaceFilePreviewMode = "preview" | "source";

function normalizedWorkspaceContentType(contentType: string | null | undefined) {
  return contentType?.toLowerCase().split(";")[0]?.trim() ?? "";
}

function hasWorkspaceFileExtension(filePath: string | null | undefined, extensions: string[]) {
  const normalized = filePath?.toLowerCase() ?? "";
  return extensions.some((extension) => normalized.endsWith(extension));
}

export function isWorkspaceMarkdownPreviewFile(file: OrganizationWorkspaceFileDetail) {
  return file.previewKind === "text"
    && file.content !== null
    && (
      hasWorkspaceFileExtension(file.filePath, WORKSPACE_MARKDOWN_FILE_EXTENSIONS)
      || normalizedWorkspaceContentType(file.contentType) === "text/markdown"
    );
}

export function isWorkspaceHtmlPreviewFile(file: OrganizationWorkspaceFileDetail) {
  return file.previewKind === "text"
    && file.content !== null
    && (
      isWorkspaceHtmlFilePath(file.filePath)
      || isWorkspaceHtmlContentType(file.contentType)
    );
}

export function isWorkspaceCsvPreviewFile(file: OrganizationWorkspaceFileDetail) {
  return file.previewKind === "text"
    && file.content !== null
    && (
      hasWorkspaceFileExtension(file.filePath, WORKSPACE_CSV_FILE_EXTENSIONS)
      || normalizedWorkspaceContentType(file.contentType) === "text/csv"
    );
}

function WorkspaceCsvPreview({ content, testId }: { content: string; testId: string }) {
  const parsed = parseWorkspaceCsvContent(content);
  const visibleRows = parsed.rows.slice(0, WORKSPACE_CSV_PREVIEW_ROW_LIMIT + 1);
  let totalColumnCount = 1;
  for (const row of visibleRows) {
    totalColumnCount = Math.max(totalColumnCount, row.length);
  }
  const { rows, columnCount } = normalizeWorkspaceCsvRows(
    visibleRows.map((row) => row.slice(0, WORKSPACE_CSV_PREVIEW_COLUMN_LIMIT)),
  );
  const header = rows[0] ?? Array.from({ length: columnCount }, () => "");
  const bodyRows = rows.slice(1);
  const hiddenRowCount = Math.max(0, parsed.rows.length - 1 - bodyRows.length);
  const hiddenColumnCount = Math.max(0, totalColumnCount - columnCount);
  const hiddenDimensions = [
    hiddenRowCount > 0 ? `${hiddenRowCount.toLocaleString()} more data rows` : null,
    hiddenColumnCount > 0 ? `${hiddenColumnCount.toLocaleString()} more columns` : null,
  ].filter((value): value is string => value !== null);

  return (
    <div
      className="scrollbar-auto-hide min-h-0 flex-1 overflow-auto"
      data-testid={testId}
      role="region"
      aria-label="CSV preview"
    >
      <table className="w-max min-w-full border-separate border-spacing-0 text-left text-sm" aria-label="CSV preview table">
        <caption className="sr-only">CSV preview with {parsed.rows.length} rows and {columnCount} visible columns</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 top-0 z-20 w-12 border-b border-r border-border bg-[color:var(--surface-page)] px-3 py-2 text-center text-xs font-medium text-muted-foreground">
              #
            </th>
            {header.map((value, columnIndex) => (
              <th
                key={columnIndex}
                scope="col"
                className="sticky top-0 z-10 min-w-[10rem] border-b border-r border-border bg-[color:var(--surface-page)] px-3 py-2 font-semibold text-foreground"
              >
                {value || `Column ${columnIndex + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th scope="row" className="sticky left-0 z-10 border-b border-r border-border bg-[color:var(--surface-page)] px-3 py-2 text-center text-xs font-medium text-muted-foreground">
                {rowIndex + 2}
              </th>
              {row.map((value, columnIndex) => (
                <td
                  key={columnIndex}
                  className="max-w-[28rem] whitespace-pre-wrap border-b border-r border-border px-3 py-2 align-top leading-6 text-foreground"
                >
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hiddenDimensions.length > 0 ? (
        <p className="sticky bottom-0 border-t border-border bg-[color:var(--surface-page)] px-4 py-2 text-xs text-muted-foreground" role="status">
          Showing a bounded table preview. Open Source to inspect {hiddenDimensions.join(" and ")}.
        </p>
      ) : null}
    </div>
  );
}

export function WorkspaceFilePreview({
  file,
  mode = "preview",
  testIdPrefix = "workspace-file",
}: {
  file: OrganizationWorkspaceFileDetail;
  mode?: WorkspaceFilePreviewMode;
  testIdPrefix?: string;
}) {
  if (file.previewKind === "text" && file.content !== null) {
    if (isWorkspaceHtmlPreviewFile(file) && mode === "preview") {
      return (
        <div className="flex min-h-[420px] flex-1 bg-white" data-testid={`${testIdPrefix}-html-preview-frame`}>
          <iframe
            data-testid={`${testIdPrefix}-html-preview`}
            title={file.filePath || "Library HTML preview"}
            srcDoc={buildWorkspaceHtmlPreviewSrcDoc(file.content)}
            sandbox=""
            referrerPolicy="no-referrer"
            className="block min-h-[420px] w-full flex-1 border-0 bg-white"
          />
        </div>
      );
    }

    if (isWorkspaceMarkdownPreviewFile(file)) {
      return (
        <article
          className="scrollbar-auto-hide min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-5"
          data-testid={`${testIdPrefix}-markdown-preview`}
          aria-label={`${file.filePath || "Library file"} preview`}
        >
          <MarkdownBody
            className="rudder-library-document-editor rudder-side-panel-library-document text-[15px] leading-7 text-foreground"
            enableCodeBlockCopy
          >
            {file.content}
          </MarkdownBody>
        </article>
      );
    }

    if (isWorkspaceCsvPreviewFile(file) && mode === "preview") {
      return <WorkspaceCsvPreview content={file.content} testId={`${testIdPrefix}-csv-preview`} />;
    }

    return (
      <WorkspaceCodeEditor
        data-testid={`${testIdPrefix}-code-preview`}
        ariaLabel={`${file.filePath || "Library file"} source`}
        filePath={file.filePath}
        value={file.content}
        readOnly
      />
    );
  }

  if (file.previewKind === "image" && file.contentPath) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4" data-testid={`${testIdPrefix}-image-preview-frame`}>
        <img
          data-testid={`${testIdPrefix}-image-preview`}
          src={file.contentPath}
          alt={file.filePath}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  if (file.previewKind === "pdf" && file.contentPath) {
    return (
      <div className="flex min-h-[420px] flex-1" data-testid={`${testIdPrefix}-pdf-preview-frame`}>
        <WorkspacePdfPreview
          className="min-h-[420px]"
          src={file.contentPath}
          testId={`${testIdPrefix}-pdf-preview`}
          title={file.filePath || "Library PDF preview"}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-center" data-testid={`${testIdPrefix}-preview-unavailable`}>
      <p className="max-w-sm text-sm leading-6 text-muted-foreground">
        {file.message ?? "No inline preview is available for this file."}
      </p>
    </div>
  );
}
