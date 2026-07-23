import type { OrganizationWorkspaceFileDetail } from "@rudderhq/shared";
import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { readDesktopShell, type DesktopLocalFilePreview } from "../../lib/desktop-shell";
import { WorkspaceFilePreview } from "../WorkspaceFilePreview";

function previewDataUrl(preview: DesktopLocalFilePreview): string | null {
  if (!preview.base64) return null;
  return `data:${preview.contentType};base64,${preview.base64}`;
}

function workspacePreviewFile(preview: DesktopLocalFilePreview): OrganizationWorkspaceFileDetail {
  return {
    source: "org_root",
    rootPath: preview.parentPath,
    repoUrl: null,
    filePath: preview.canonicalPath,
    libraryEntryId: null,
    mentionHref: null,
    markdownLink: null,
    rootExists: true,
    content: preview.content,
    contentType: preview.contentType,
    previewKind: preview.previewKind === "image" || preview.previewKind === "pdf"
      ? preview.previewKind
      : "text",
    contentPath: previewDataUrl(preview),
    message: null,
    truncated: preview.truncated,
  };
}

export function TranscriptLocalFilePreview({
  targetPath,
  label,
}: {
  targetPath: string;
  label: string;
}) {
  const desktopShell = readDesktopShell();
  const [preview, setPreview] = useState<DesktopLocalFilePreview | null>(null);
  const [error, setError] = useState<string | null>(() => (
    desktopShell ? null : "Local file previews are available in the Rudder Desktop app."
  ));
  const [loading, setLoading] = useState(Boolean(desktopShell));
  const previewRequestRef = useRef<{
    targetPath: string;
    promise: Promise<DesktopLocalFilePreview>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!desktopShell) {
      setPreview(null);
      setLoading(false);
      setError("Local file previews are available in the Rudder Desktop app.");
      return undefined;
    }

    setLoading(true);
    setError(null);
    if (previewRequestRef.current?.targetPath !== targetPath) {
      previewRequestRef.current = {
        targetPath,
        promise: desktopShell.previewLocalFile(targetPath),
      };
    }
    void previewRequestRef.current.promise
      .then((nextPreview) => {
        if (!cancelled) setPreview(nextPreview);
      })
      .catch((cause) => {
        if (!cancelled) {
          setPreview(null);
          setError(cause instanceof Error ? cause.message : `Could not preview ${label}.`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [desktopShell, label, targetPath]);

  const file = useMemo(() => preview ? workspacePreviewFile(preview) : null, [preview]);
  const openPreview = async () => {
    if (!desktopShell || !preview) return;
    try {
      await desktopShell.openPath(preview.canonicalPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not open ${label}.`);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[16rem] items-center justify-center text-sm text-muted-foreground" role="status">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
        Loading {label}
      </div>
    );
  }

  if (error || !preview || !file) {
    return (
      <div className="p-4">
        <div role="alert" className="rounded-[var(--radius-md)] border border-border bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
          {error ?? `Could not preview ${label}.`}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-side-panel-local-file-view">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground" title={preview.canonicalPath}>
            {preview.fileName || label}
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={() => void openPreview()}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          Open
        </button>
      </div>
      {preview.truncated ? (
        <div className="shrink-0 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200" role="status">
          Showing a bounded preview. Open the file to inspect the complete content.
        </div>
      ) : null}
      <WorkspaceFilePreview
        file={file}
        organizationId="local-transcript-file"
        testIdPrefix="transcript-local-file"
      />
    </div>
  );
}
