import type { OrganizationWorkspaceFileDetail } from "@rudderhq/shared";
import { ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  readDesktopShell,
  type DesktopLocalFilePreview,
  type DesktopWorkspaceLaunchTarget,
} from "../../lib/desktop-shell";
import {
  isWorkspaceFileOpenTarget,
  workspaceUnsupportedFileLaunchTargets,
  type WorkspaceOpenTargetId,
  type WorkspaceUnsupportedFileLaunchTarget,
} from "../../lib/workspace-preferences";
import {
  clearChatSidePanelMarkdownDraft,
  joinChatSidePanelYamlFrontmatter,
  restoreChatSidePanelMarkdownDraft,
  splitChatSidePanelYamlFrontmatter,
  storeChatSidePanelMarkdownDraft,
} from "../../pages/Chat.side-panel.helpers";
import {
  FileAnnotationSelectionToolbar,
  type FileTextSelection,
} from "../chat/FileAnnotationSelectionToolbar";
import { MarkdownEditor } from "../MarkdownEditor";
import { WorkspaceCodeEditor } from "../WorkspaceCodeEditor";
import { WorkspaceFilePreview } from "../WorkspaceFilePreview";
import { WorkspaceFileOpenMenu } from "../workspaces/WorkspaceLaunchControls";

const LOCAL_FILE_DRAFT_SCOPE = "desktop-local-file";

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

function previewFailureMessage(cause: unknown, label: string): string {
  const message = cause instanceof Error ? cause.message : "";
  if (/\bENOENT\b|no such file or directory/iu.test(message)) {
    return "Could not resolve the file location recorded by this run. The file may have moved, or an older transcript may not include the command's original working directory.";
  }
  return message || `Could not preview ${label}.`;
}

function DesktopLocalTextFileEditor({
  preview,
  sourceConversationId,
  onPreviewChange,
  onAnnotationSelectionPendingChange,
}: {
  preview: DesktopLocalFilePreview;
  sourceConversationId: string | null;
  onPreviewChange: (preview: DesktopLocalFilePreview) => void;
  onAnnotationSelectionPendingChange?: (pending: boolean) => void;
}) {
  const desktopShell = readDesktopShell();
  const initialContent = preview.content ?? "";
  const restoredDraftRef = useRef(
    restoreChatSidePanelMarkdownDraft(
      LOCAL_FILE_DRAFT_SCOPE,
      preview.canonicalPath,
      initialContent,
    ),
  );
  const restoredDraft = restoredDraftRef.current;
  const syncedContentRef = useRef(restoredDraft.baseContent);
  const draftContentRef = useRef(restoredDraft.content);
  const latestContentRef = useRef(initialContent);
  const saveInFlightRef = useRef(false);
  const queuedSaveRef = useRef<string | null>(null);
  const conflictRef = useRef(restoredDraft.conflicted);
  const [draftContent, setDraftContent] = useState(restoredDraft.content);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">(
    restoredDraft.conflicted ? "error" : restoredDraft.content === initialContent ? "saved" : "saving",
  );
  const [saveError, setSaveError] = useState<string | null>(
    restoredDraft.conflicted
      ? "This file changed outside Rudder. Choose which version to keep."
      : null,
  );
  const [conflict, setConflict] = useState(restoredDraft.conflicted);
  const annotationContainerRef = useRef<HTMLDivElement | null>(null);
  const [codeSelection, setCodeSelection] = useState<FileTextSelection | null>(null);

  const acceptSavedPreview = useCallback((nextPreview: DesktopLocalFilePreview) => {
    const savedContent = nextPreview.content ?? draftContentRef.current;
    syncedContentRef.current = savedContent;
    latestContentRef.current = savedContent;
    conflictRef.current = false;
    setConflict(false);
    setSaveError(null);
    onPreviewChange(nextPreview);
    storeChatSidePanelMarkdownDraft(
      LOCAL_FILE_DRAFT_SCOPE,
      preview.canonicalPath,
      savedContent,
      draftContentRef.current,
    );
    if (draftContentRef.current !== savedContent) {
      queuedSaveRef.current = draftContentRef.current;
    }
  }, [onPreviewChange, preview.canonicalPath]);

  useEffect(() => () => {
    storeChatSidePanelMarkdownDraft(
      LOCAL_FILE_DRAFT_SCOPE,
      preview.canonicalPath,
      syncedContentRef.current,
      draftContentRef.current,
    );
  }, [preview.canonicalPath]);

  const drainSaveQueue = useCallback(async () => {
    if (!desktopShell || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    try {
      while (queuedSaveRef.current !== null) {
        const content = queuedSaveRef.current;
        queuedSaveRef.current = null;
        if (conflictRef.current || content === syncedContentRef.current) continue;
        setSaveStatus("saving");
        setSaveError(null);
        try {
          const saved = await desktopShell.updateLocalFile(preview.canonicalPath, {
            content,
            expectedContent: syncedContentRef.current,
            writeCapability: preview.writeCapability ?? "",
          });
          acceptSavedPreview(saved);
        } catch (cause) {
          let latest: DesktopLocalFilePreview | null = null;
          try {
            latest = await desktopShell.previewLocalFile(preview.canonicalPath);
          } catch {
            // Keep the original mutation error when verification also fails.
          }
          if (latest?.content === content) {
            acceptSavedPreview(latest);
            continue;
          }
          if (latest && latest.content !== null && latest.content !== syncedContentRef.current) {
            latestContentRef.current = latest.content;
            conflictRef.current = true;
            setConflict(true);
          }
          setSaveStatus("error");
          setSaveError(
            conflictRef.current
              ? "This file changed outside Rudder. Choose which version to keep."
              : cause instanceof Error ? cause.message : "Could not save this file.",
          );
          return;
        }
      }
      setSaveStatus(
        draftContentRef.current === syncedContentRef.current ? "saved" : "saving",
      );
    } finally {
      saveInFlightRef.current = false;
      if (queuedSaveRef.current !== null && !conflictRef.current) {
        void drainSaveQueue();
      }
    }
  }, [acceptSavedPreview, desktopShell, preview.canonicalPath]);

  useEffect(() => {
    storeChatSidePanelMarkdownDraft(
      LOCAL_FILE_DRAFT_SCOPE,
      preview.canonicalPath,
      syncedContentRef.current,
      draftContent,
    );
    if (conflictRef.current || draftContent === syncedContentRef.current) return undefined;
    setSaveStatus("saving");
    const timeout = window.setTimeout(() => {
      queuedSaveRef.current = draftContent;
      void drainSaveQueue();
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [draftContent, drainSaveQueue, preview.canonicalPath]);

  const handleChange = (content: string) => {
    draftContentRef.current = content;
    setDraftContent(content);
    setSaveStatus(conflictRef.current ? "error" : "saving");
    if (!conflictRef.current) setSaveError(null);
  };
  const keepMine = () => {
    syncedContentRef.current = latestContentRef.current;
    conflictRef.current = false;
    setConflict(false);
    setSaveStatus("saving");
    setSaveError(null);
    queuedSaveRef.current = draftContentRef.current;
    void drainSaveQueue();
  };
  const useLatest = () => {
    const content = latestContentRef.current;
    syncedContentRef.current = content;
    draftContentRef.current = content;
    queuedSaveRef.current = null;
    conflictRef.current = false;
    setConflict(false);
    setDraftContent(content);
    setSaveStatus("saved");
    setSaveError(null);
    clearChatSidePanelMarkdownDraft(LOCAL_FILE_DRAFT_SCOPE, preview.canonicalPath);
  };
  const retry = () => {
    queuedSaveRef.current = draftContentRef.current;
    void drainSaveQueue();
  };
  const markdownParts = preview.previewKind === "markdown"
    ? splitChatSidePanelYamlFrontmatter(draftContent)
    : { frontmatter: null, separator: "", body: draftContent };

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden"
      data-testid="chat-side-panel-local-file-editor"
    >
      {preview.previewKind === "markdown" ? (
        <div ref={annotationContainerRef} className="scrollbar-auto-hide min-h-0 min-w-0 flex-1 overflow-y-auto px-5 pb-16 pt-5">
          <div className="rudder-readable-document mx-auto w-full max-w-[880px]">
            {markdownParts.frontmatter !== null ? (
              <details
                className="group mb-6 rounded-md border border-border bg-muted/20"
                data-chat-annotation-ignore
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                  <span>Frontmatter</span>
                  <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                </summary>
                <textarea
                  value={markdownParts.frontmatter}
                  onChange={(event) => handleChange(joinChatSidePanelYamlFrontmatter(
                    event.currentTarget.value,
                    markdownParts.separator,
                    markdownParts.body,
                  ))}
                  spellCheck={false}
                  className="block min-h-28 w-full resize-y border-t border-border bg-transparent px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none"
                  aria-label="Frontmatter"
                />
              </details>
            ) : null}
            <MarkdownEditor
              key={preview.canonicalPath}
              engine="milkdown"
              value={markdownParts.body}
              onChange={(body) => handleChange(joinChatSidePanelYamlFrontmatter(
                markdownParts.frontmatter,
                markdownParts.separator,
                body,
              ))}
              bordered={false}
              placeholder="Write in Markdown..."
              contentClassName="rudder-library-document-editor rudder-side-panel-library-document min-h-[420px] text-[15px] leading-7 text-foreground"
            />
          </div>
        </div>
      ) : (
        <div ref={annotationContainerRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-14">
          <WorkspaceCodeEditor
            data-testid="chat-side-panel-local-file-source-editor"
            annotationSource={{
              surface: "local_file",
              sourceFilePath: preview.canonicalPath,
            }}
            ariaLabel={`${preview.fileName} source editor`}
            filePath={preview.canonicalPath}
            value={draftContent}
            onChange={handleChange}
            onSelectionChange={setCodeSelection}
          />
        </div>
      )}
      <FileAnnotationSelectionToolbar
        containerRef={annotationContainerRef}
        conversationId={sourceConversationId}
        explicitSelection={preview.previewKind === "markdown" ? undefined : codeSelection}
        saved={
          saveStatus === "saved"
          && !conflict
          && draftContent === syncedContentRef.current
        }
        source={draftContent}
        sourceIdentity={{
          surface: "local_file",
          sourceFilePath: preview.canonicalPath,
        }}
        sourceRenderMode={preview.previewKind === "markdown" ? "markdown" : "text"}
        renderedSource={preview.previewKind === "markdown" ? markdownParts.body : draftContent}
        renderedSourceOffset={
          preview.previewKind === "markdown"
            ? draftContent.length - markdownParts.body.length
            : 0
        }
        onPendingChange={onAnnotationSelectionPendingChange}
      />
      <div
        className={`absolute bottom-3 left-3 z-10 flex min-h-8 items-center gap-2 rounded-md border border-border bg-[color:var(--surface-elevated)] px-2.5 text-xs shadow-sm ${saveStatus === "error" ? "text-destructive" : "text-muted-foreground"}`}
        role={saveStatus === "error" ? "alert" : "status"}
        title={saveError ?? undefined}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${saveStatus === "error" ? "bg-destructive" : saveStatus === "saving" ? "bg-[color:var(--accent-strong)]" : "bg-emerald-500"}`} />
        <span>{conflict ? "Conflict" : saveStatus === "error" ? "Save failed" : saveStatus === "saving" ? "Saving" : "Saved"}</span>
        {conflict ? (
          <>
            <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={keepMine}>Keep mine</button>
            <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={useLatest}>Use latest</button>
          </>
        ) : saveStatus === "error" ? (
          <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={retry}>Retry</button>
        ) : null}
      </div>
    </div>
  );
}

export function TranscriptLocalFilePreview({
  targetPath,
  label,
  sourceConversationId = null,
  onAnnotationSelectionPendingChange,
}: {
  targetPath: string;
  label: string;
  sourceConversationId?: string | null;
  onAnnotationSelectionPendingChange?: (pending: boolean) => void;
}) {
  const desktopShell = readDesktopShell();
  const [preview, setPreview] = useState<DesktopLocalFilePreview | null>(null);
  const [launchTargets, setLaunchTargets] = useState<DesktopWorkspaceLaunchTarget[]>([]);
  const [launchTargetsDiscovered, setLaunchTargetsDiscovered] = useState(false);
  const [openingTargetId, setOpeningTargetId] = useState<WorkspaceOpenTargetId | null>(null);
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
          setError(previewFailureMessage(cause, label));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [desktopShell, label, targetPath]);

  useEffect(() => {
    let cancelled = false;
    setLaunchTargets([]);
    setLaunchTargetsDiscovered(false);
    if (
      !preview?.parentPath
      || !preview.fileName
      || typeof desktopShell?.listWorkspaceLaunchTargets !== "function"
    ) {
      setLaunchTargets([]);
      return undefined;
    }
    void desktopShell.listWorkspaceLaunchTargets()
      .then((targets) => {
        if (!cancelled) {
          setLaunchTargets(targets);
          setLaunchTargetsDiscovered(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLaunchTargetsDiscovered(false);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopShell, preview?.canonicalPath, preview?.fileName, preview?.parentPath]);

  const file = useMemo(() => preview ? workspacePreviewFile(preview) : null, [preview]);
  const openTargets = useMemo(
    () => launchTargetsDiscovered ? workspaceUnsupportedFileLaunchTargets(launchTargets, {
      canOpenFile: Boolean(
        preview?.parentPath
        && preview.fileName
        && typeof desktopShell?.openWorkspaceFileInIde === "function",
      ),
      canOpenLocation: Boolean(
        preview?.parentPath
        && preview.fileName
        && typeof desktopShell?.openWorkspaceFileLocation === "function",
      ),
    }) : [],
    [desktopShell, launchTargets, launchTargetsDiscovered, preview?.fileName, preview?.parentPath],
  );
  const openPreview = async (target?: WorkspaceUnsupportedFileLaunchTarget) => {
    if (!desktopShell || !preview) return;
    setOpeningTargetId(target?.id ?? null);
    try {
      if (target && isWorkspaceFileOpenTarget(target) && target.id !== "defaultApp") {
        await desktopShell.openWorkspaceFileInIde(preview.parentPath, preview.fileName, target.id);
      } else if (target?.id === "defaultApp") {
        await desktopShell.openPath(preview.canonicalPath);
      } else if (target) {
        await desktopShell.openWorkspaceFileLocation?.(preview.parentPath, preview.fileName, target.id);
      } else {
        await desktopShell.openPath(preview.canonicalPath);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not open ${label}.`);
    } finally {
      setOpeningTargetId(null);
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
    <div
      className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden"
      data-testid="chat-side-panel-local-file-view"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground" title={preview.canonicalPath}>
            {preview.fileName || label}
          </div>
        </div>
        {openTargets.length > 0 ? (
          <WorkspaceFileOpenMenu
            targets={openTargets}
            openingTargetId={openingTargetId}
            onOpenTarget={(target) => void openPreview(target)}
            testId="chat-side-panel-local-file-open-menu"
          />
        ) : (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={() => void openPreview()}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Open
          </button>
        )}
      </div>
      {preview.truncated ? (
        <div className="shrink-0 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200" role="status">
          Showing a bounded preview. Open the file to inspect the complete content.
        </div>
      ) : null}
      {!preview.truncated && preview.content !== null ? (
        <DesktopLocalTextFileEditor
          preview={preview}
          sourceConversationId={sourceConversationId}
          onPreviewChange={setPreview}
          onAnnotationSelectionPendingChange={onAnnotationSelectionPendingChange}
        />
      ) : (
        <WorkspaceFilePreview
          file={file}
          organizationId="local-transcript-file"
          testIdPrefix="transcript-local-file"
        />
      )}
    </div>
  );
}
