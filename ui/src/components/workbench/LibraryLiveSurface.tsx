import { organizationsApi } from "@/api/orgs";

import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { WorkspaceCodeEditor } from "@/components/WorkspaceCodeEditor";
import {
  isWorkspaceCsvPreviewFile,
  isWorkspaceHtmlPreviewFile,
  WorkspaceFilePreview,
} from "@/components/WorkspaceFilePreview";
import { WorkspaceHtmlPreviewToolbar } from "@/components/WorkspaceHtmlPreview";
import {
  FileAnnotationSelectionToolbar,
  type FileTextSelection,
} from "@/components/chat/FileAnnotationSelectionToolbar";
import { WorkspaceFileOpenMenu } from "@/components/workspaces/WorkspaceLaunchControls";
import type { LiveSurfaceTarget } from "@/context/LiveSurfaceRuntimeContext";
import { useToast } from "@/context/ToastContext";
import {
  readDesktopShell,
  type DesktopWorkspaceLaunchTarget,
} from "@/lib/desktop-shell";
import {
  applyOrganizationPrefix,
  extractOrganizationPrefixFromPath,
} from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import {
  isWorkspaceFileOpenTarget,
  workspaceUnsupportedFileLaunchTargets,
  type WorkspaceOpenTargetId,
  type WorkspaceUnsupportedFileLaunchTarget,
} from "@/lib/workspace-preferences";
import {
  clearChatSidePanelMarkdownDraft,
  joinChatSidePanelYamlFrontmatter,
  restoreChatSidePanelMarkdownDraft,
  splitChatSidePanelYamlFrontmatter,
  storeChatSidePanelMarkdownDraft,
} from "@/pages/Chat.side-panel.helpers";
import type { OrganizationWorkspaceFileDetail } from "@rudderhq/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  RotateCw,
  Table2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type LibraryTarget = Extract<
  LiveSurfaceTarget,
  {
    kind:
      | "library_directory"
      | "library_document"
      | "library_entry"
      | "library_file";
  }
>;

const LIBRARY_LIVE_SURFACE_CONFLICT =
  "This file changed while you were editing it.";

function fileLabel(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function editableTextFile(file: OrganizationWorkspaceFileDetail) {
  if (
    file.truncated
    || file.previewKind !== "text"
    || file.content === null
  ) {
    return false;
  }
  return true;
}

function markdownFile(file: OrganizationWorkspaceFileDetail) {
  return /\.(?:md|markdown|mdown|mdx)$/i.test(file.filePath);
}

function LibraryTextEditor({
  annotationConversationId,
  file,
  organizationId,
  sourceToolbar,
}: {
  annotationConversationId: string | null;
  file: OrganizationWorkspaceFileDetail;
  organizationId: string;
  sourceToolbar?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const filePath = file.filePath;
  const serverContent = file.content ?? "";
  const restoredDraftRef = useRef(
    restoreChatSidePanelMarkdownDraft(
      organizationId,
      filePath,
      serverContent,
    ),
  );
  const restoredDraft = restoredDraftRef.current;
  const mountedRef = useRef(true);
  const syncedContentRef = useRef(restoredDraft.baseContent);
  const latestServerContentRef = useRef(serverContent);
  const draftContentRef = useRef(restoredDraft.content);
  const queuedSaveRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);
  const conflictRef = useRef(restoredDraft.conflicted);
  const resolutionVersionRef = useRef(0);
  const [draft, setDraft] = useState(restoredDraft.content);
  const [status, setStatus] = useState<"error" | "saved" | "saving">(
    restoredDraft.conflicted
      ? "error"
      : restoredDraft.content === serverContent
        ? "saved"
        : "saving",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(
    restoredDraft.conflicted ? LIBRARY_LIVE_SURFACE_CONFLICT : null,
  );
  const annotationContainerRef = useRef<HTMLDivElement | null>(null);
  const [codeSelection, setCodeSelection] = useState<FileTextSelection | null>(
    null,
  );
  const markdown = markdownFile(file);

  draftContentRef.current = draft;
  latestServerContentRef.current = serverContent;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      storeChatSidePanelMarkdownDraft(
        organizationId,
        filePath,
        syncedContentRef.current,
        draftContentRef.current,
      );
    };
  }, [filePath, organizationId]);

  useEffect(() => {
    if (serverContent === syncedContentRef.current) return;
    if (serverContent === draftContentRef.current) {
      syncedContentRef.current = serverContent;
      conflictRef.current = false;
      setStatus("saved");
      setErrorMessage(null);
      clearChatSidePanelMarkdownDraft(organizationId, filePath);
      return;
    }
    if (draftContentRef.current === syncedContentRef.current) {
      syncedContentRef.current = serverContent;
      draftContentRef.current = serverContent;
      setDraft(serverContent);
      conflictRef.current = false;
      setStatus("saved");
      setErrorMessage(null);
      clearChatSidePanelMarkdownDraft(organizationId, filePath);
      return;
    }
    queuedSaveRef.current = null;
    resolutionVersionRef.current += 1;
    conflictRef.current = true;
    setStatus("error");
    setErrorMessage(LIBRARY_LIVE_SURFACE_CONFLICT);
    storeChatSidePanelMarkdownDraft(
      organizationId,
      filePath,
      syncedContentRef.current,
      draftContentRef.current,
    );
  }, [filePath, organizationId, serverContent]);

  const acceptSavedDetail = useCallback((
    detail: OrganizationWorkspaceFileDetail,
    attemptedContent: string,
  ) => {
    const savedContent = detail.content ?? attemptedContent;
    syncedContentRef.current = savedContent;
    latestServerContentRef.current = savedContent;
    conflictRef.current = false;
    queryClient.setQueryData(
      queryKeys.organizations.workspaceFile(organizationId, filePath),
      detail,
    );
    storeChatSidePanelMarkdownDraft(
      organizationId,
      filePath,
      savedContent,
      draftContentRef.current,
    );
    if (draftContentRef.current !== savedContent) {
      queuedSaveRef.current = draftContentRef.current;
    }
    if (mountedRef.current) {
      setErrorMessage(null);
      setStatus(
        draftContentRef.current === savedContent ? "saved" : "saving",
      );
    }
  }, [filePath, organizationId, queryClient]);

  const drainSaveQueue = useCallback(async () => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    try {
      while (queuedSaveRef.current !== null) {
        const content = queuedSaveRef.current;
        const resolutionVersion = resolutionVersionRef.current;
        queuedSaveRef.current = null;
        if (conflictRef.current) return;
        if (content === syncedContentRef.current) continue;
        if (mountedRef.current) {
          setStatus("saving");
          setErrorMessage(null);
        }
        try {
          const saved = await organizationsApi.updateWorkspaceFile(
            organizationId,
            filePath,
            {
              content,
              expectedContent: syncedContentRef.current,
            },
          );
          if (resolutionVersion !== resolutionVersionRef.current) continue;
          acceptSavedDetail(saved, content);
        } catch (error) {
          if (resolutionVersion !== resolutionVersionRef.current) continue;
          let latest: OrganizationWorkspaceFileDetail | null = null;
          try {
            latest = await organizationsApi.readWorkspaceFile(
              organizationId,
              filePath,
            );
          } catch {
            // Keep the original save failure when reconciliation also fails.
          }
          if (resolutionVersion !== resolutionVersionRef.current) continue;
          if (latest) {
            latestServerContentRef.current = latest.content ?? "";
            queryClient.setQueryData(
              queryKeys.organizations.workspaceFile(organizationId, filePath),
              latest,
            );
          }
          if (latest?.content === content) {
            acceptSavedDetail(latest, content);
            continue;
          }
          if (latest && latest.content !== syncedContentRef.current) {
            queuedSaveRef.current = null;
            conflictRef.current = true;
            storeChatSidePanelMarkdownDraft(
              organizationId,
              filePath,
              syncedContentRef.current,
              draftContentRef.current,
            );
          }
          if (mountedRef.current) {
            setStatus("error");
            setErrorMessage(
              conflictRef.current
                ? LIBRARY_LIVE_SURFACE_CONFLICT
                : error instanceof Error
                  ? error.message
                  : "Could not save this file.",
            );
          }
          return;
        }
      }
      if (mountedRef.current) {
        setStatus(
          draftContentRef.current === syncedContentRef.current
            ? "saved"
            : "saving",
        );
      }
    } finally {
      saveInFlightRef.current = false;
      if (queuedSaveRef.current !== null && !conflictRef.current) {
        void drainSaveQueue();
      }
    }
  }, [acceptSavedDetail, filePath, organizationId, queryClient]);

  const enqueueSave = useCallback((content: string) => {
    queuedSaveRef.current = content;
    void drainSaveQueue();
  }, [drainSaveQueue]);

  useEffect(() => {
    storeChatSidePanelMarkdownDraft(
      organizationId,
      filePath,
      syncedContentRef.current,
      draft,
    );
    if (conflictRef.current) return undefined;
    if (draft === syncedContentRef.current) {
      setStatus(
        saveInFlightRef.current || queuedSaveRef.current !== null
          ? "saving"
          : "saved",
      );
      return undefined;
    }
    const timer = window.setTimeout(() => enqueueSave(draft), 700);
    return () => window.clearTimeout(timer);
  }, [draft, enqueueSave, filePath, organizationId]);

  const useLatest = () => {
    const content = latestServerContentRef.current;
    resolutionVersionRef.current += 1;
    syncedContentRef.current = content;
    draftContentRef.current = content;
    queuedSaveRef.current = null;
    conflictRef.current = false;
    setDraft(content);
    setStatus("saved");
    setErrorMessage(null);
    clearChatSidePanelMarkdownDraft(organizationId, filePath);
  };

  const keepMine = () => {
    resolutionVersionRef.current += 1;
    syncedContentRef.current = latestServerContentRef.current;
    conflictRef.current = false;
    setStatus("saving");
    setErrorMessage(null);
    enqueueSave(draftContentRef.current);
  };

  const markdownParts = markdown
    ? splitChatSidePanelYamlFrontmatter(draft)
    : { frontmatter: null, separator: "", body: draft };

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden"
      data-testid={markdown
        ? "library-live-surface-markdown-editor"
        : "library-live-surface-text-editor"}
    >
      {sourceToolbar}
      <div
        ref={annotationContainerRef}
        className={cn(
          "min-h-0 flex-1",
          markdown
            ? "scrollbar-auto-hide overflow-y-auto px-6 py-6"
            : "overflow-hidden",
        )}
      >
        {markdown ? (
          <>
            {markdownParts.frontmatter !== null ? (
              <details
                className="group mb-6 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-page)]"
                data-chat-annotation-ignore
                data-testid="library-live-surface-frontmatter-editor"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <span>Frontmatter</span>
                  <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                </summary>
                <textarea
                  value={markdownParts.frontmatter}
                  onChange={(event) => {
                    const content = joinChatSidePanelYamlFrontmatter(
                      event.currentTarget.value,
                      markdownParts.separator,
                      markdownParts.body,
                    );
                    draftContentRef.current = content;
                    setDraft(content);
                    setStatus(conflictRef.current ? "error" : "saving");
                    if (!conflictRef.current) setErrorMessage(null);
                  }}
                  spellCheck={false}
                  className="block min-h-28 w-full resize-y border-t border-[color:var(--border-soft)] bg-transparent px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none"
                  aria-label="Frontmatter"
                />
              </details>
            ) : null}
            <MarkdownEditor
              key={filePath}
              engine="codemirror"
              documentIdentity={`library-file:${filePath}`}
              value={markdownParts.body}
              onChange={(body) => {
                const content = joinChatSidePanelYamlFrontmatter(
                  markdownParts.frontmatter,
                  markdownParts.separator,
                  body,
                );
                draftContentRef.current = content;
                setDraft(content);
                setStatus(conflictRef.current ? "error" : "saving");
                if (!conflictRef.current) setErrorMessage(null);
              }}
              bordered={false}
              placeholder="Write in Markdown..."
              contentClassName="rudder-library-document-editor rudder-readable-document mx-auto min-h-[420px] w-full max-w-[880px] text-[15px] leading-7 text-foreground"
            />
          </>
        ) : (
          <WorkspaceCodeEditor
            data-testid="library-live-surface-text-source-editor"
            annotationSource={{
              surface: "workspace_file",
              sourceFilePath: filePath,
            }}
            ariaLabel={`${filePath} source editor`}
            filePath={filePath}
            value={draft}
            onChange={(content) => {
              draftContentRef.current = content;
              setDraft(content);
              setStatus(conflictRef.current ? "error" : "saving");
              if (!conflictRef.current) setErrorMessage(null);
            }}
            onSelectionChange={setCodeSelection}
          />
        )}
      </div>
      <FileAnnotationSelectionToolbar
        containerRef={annotationContainerRef}
        conversationId={annotationConversationId}
        explicitSelection={markdown ? undefined : codeSelection}
        saved={
          status === "saved"
          && !conflictRef.current
          && draft === syncedContentRef.current
        }
        source={draft}
        sourceIdentity={{
          surface: "workspace_file",
          sourceFilePath: filePath,
          sourceLibraryEntryId: file.libraryEntryId,
        }}
        sourceRenderMode={markdown ? "markdown" : "text"}
        renderedSource={markdown ? markdownParts.body : draft}
        renderedSourceOffset={markdown ? draft.length - markdownParts.body.length : 0}
      />
      <div
        className={cn(
          "flex min-h-10 shrink-0 items-center gap-2 border-t border-border/70 px-4 text-xs",
          status === "error"
            ? "text-destructive"
            : "text-muted-foreground",
        )}
        role={status === "error" ? "alert" : "status"}
      >
        <span>
          {status === "saved"
            ? "Saved"
            : status === "saving"
              ? "Saving…"
              : errorMessage ?? "Save failed"}
        </span>
        {conflictRef.current ? (
          <>
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={keepMine}
            >
              Keep mine
            </button>
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={useLatest}
            >
              Use latest
            </button>
          </>
        ) : status === "error" ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2"
            onClick={() => enqueueSave(draftContentRef.current)}
          >
            <RotateCw className="h-3 w-3" aria-hidden />
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

function unavailable(message: string) {
  return (
    <div
      className="m-auto max-w-sm px-6 py-10 text-center text-sm leading-6 text-muted-foreground"
      data-testid="library-live-surface-unavailable"
      role="status"
    >
      {message}
    </div>
  );
}

export function LibraryLiveSurface({
  active,
  annotationConversationId = null,
  organizationId,
  surface,
  target,
  onOpenTarget,
}: {
  active: boolean;
  annotationConversationId?: string | null;
  organizationId: string;
  surface: "side_panel" | "workbench";
  target: LibraryTarget;
  onOpenTarget: (target: SidePanelTarget) => void;
}) {
  const { pushToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const desktopShell = readDesktopShell();
  const [launchTargets, setLaunchTargets] = useState<
    DesktopWorkspaceLaunchTarget[]
  >([]);
  const [openingTargetId, setOpeningTargetId] =
    useState<WorkspaceOpenTargetId | null>(null);
  const [filePreviewMode, setFilePreviewMode] =
    useState<"preview" | "source">("preview");
  const entryTarget = target.kind === "library_entry" ? target : null;
  const documentTarget = target.kind === "library_document" ? target : null;
  const directoryTarget = target.kind === "library_directory" ? target : null;
  const directoryPath = directoryTarget?.directoryPath ?? "";
  const directFilePath = target.kind === "library_file"
    ? target.filePath
    : entryTarget?.path ?? null;

  const entryQuery = useQuery({
    queryKey: queryKeys.organizations.libraryEntry(
      organizationId,
      entryTarget?.entryId ?? "__none__",
    ),
    queryFn: () => organizationsApi.getLibraryEntry(
      organizationId,
      entryTarget!.entryId,
    ),
    enabled: Boolean(entryTarget),
    refetchOnWindowFocus: false,
  });
  const filePath = directFilePath
    ?? (
      entryQuery.data?.status === "active"
        ? entryQuery.data.currentPath
        : null
    );
  const fileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFile(
      organizationId,
      filePath ?? "",
    ),
    queryFn: () => organizationsApi.readWorkspaceFile(
      organizationId,
      filePath!,
    ),
    enabled: Boolean(
      target.kind === "library_file"
      || target.kind === "library_entry",
    ) && Boolean(filePath),
    refetchOnWindowFocus: false,
  });
  const documentQuery = useQuery({
    queryKey: queryKeys.organizations.libraryDocument(
      organizationId,
      documentTarget?.documentId ?? "__none__",
    ),
    queryFn: () => organizationsApi.getLibraryDocument(
      organizationId,
      documentTarget!.documentId,
    ),
    enabled: Boolean(documentTarget),
    refetchOnWindowFocus: false,
  });
  const directoryQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(
      organizationId,
      directoryPath,
    ),
    queryFn: () => organizationsApi.listWorkspaceFiles(organizationId, directoryPath),
    enabled: Boolean(directoryTarget),
    refetchOnWindowFocus: false,
  });
  const file = fileQuery.data;
  const previewFirstFile = file
    ? isWorkspaceHtmlPreviewFile(file) || isWorkspaceCsvPreviewFile(file)
    : false;

  useEffect(() => {
    setFilePreviewMode("preview");
  }, [filePath]);
  const fileOpenTargets = workspaceUnsupportedFileLaunchTargets(
    launchTargets,
    {
      canOpenFile: Boolean(
        file?.rootPath
        && typeof desktopShell?.openWorkspaceFileInIde === "function"
      ),
      canOpenLocation: Boolean(
        file?.rootPath
        && typeof desktopShell?.openWorkspaceFileLocation === "function"
      ),
    },
  );

  useEffect(() => {
    let cancelled = false;
    if (
      !file?.rootPath
      || typeof desktopShell?.listWorkspaceLaunchTargets !== "function"
    ) {
      setLaunchTargets([]);
      return undefined;
    }
    void desktopShell.listWorkspaceLaunchTargets()
      .then((targets) => {
        if (!cancelled) setLaunchTargets(targets);
      })
      .catch(() => {
        if (!cancelled) setLaunchTargets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopShell, file?.rootPath]);

  const openFileTarget = async (
    openTarget: WorkspaceUnsupportedFileLaunchTarget,
  ) => {
    if (!file?.rootPath || !desktopShell) return;
    setOpeningTargetId(openTarget.id);
    try {
      if (isWorkspaceFileOpenTarget(openTarget)) {
        await desktopShell.openWorkspaceFileInIde(
          file.rootPath,
          file.filePath,
          openTarget.id,
        );
      } else {
        await desktopShell.openWorkspaceFileLocation?.(
          file.rootPath,
          file.filePath,
          openTarget.id,
        );
      }
      pushToast({
        title: `Opened in ${openTarget.label}`,
        tone: "success",
      });
    } catch (openError) {
      pushToast({
        title: `Could not open in ${openTarget.label}`,
        body: openError instanceof Error
          ? openError.message
          : "Try another app.",
        tone: "error",
      });
    } finally {
      setOpeningTargetId(null);
    }
  };

  // Disabled TanStack queries report a pending state. Gate every pending/error
  // branch by the target kind so a Library file cannot be stuck behind a
  // disabled document or directory query.
  const pending = Boolean(
    (target.kind === "library_entry" && entryQuery.isPending)
    || (
      (target.kind === "library_file" || target.kind === "library_entry")
      && Boolean(filePath)
      && fileQuery.isPending
    )
    || (target.kind === "library_document" && documentQuery.isPending)
    || (target.kind === "library_directory" && directoryQuery.isPending)
  );
  const error = target.kind === "library_entry"
    ? entryQuery.error ?? fileQuery.error
    : target.kind === "library_file"
      ? fileQuery.error
      : target.kind === "library_document"
        ? documentQuery.error
        : directoryQuery.error;

  let content;
  if (pending) {
    content = (
      <div
        className="m-auto text-sm text-muted-foreground"
        data-testid="library-live-surface-loading"
      >
        Loading Library item…
      </div>
    );
  } else if (error) {
    content = (
      <div
        className="m-auto max-w-sm px-6 py-10 text-center text-sm leading-6 text-destructive"
        data-testid="library-live-surface-error"
        role="alert"
      >
        {error instanceof Error
          ? error.message
          : "Could not open this Library item."}
      </div>
    );
  } else if (target.kind === "library_entry" && !filePath) {
    content = unavailable(
      entryQuery.data?.status === "deleted"
        ? "This Library entry was deleted."
        : "This Library entry is unavailable on its original path.",
    );
  } else if (
    (target.kind === "library_file" || target.kind === "library_entry")
    && fileQuery.data
  ) {
    content = editableTextFile(fileQuery.data)
      && (!previewFirstFile || filePreviewMode === "source") ? (
      <LibraryTextEditor
        key={fileQuery.data.filePath}
        annotationConversationId={annotationConversationId}
        file={fileQuery.data}
        organizationId={organizationId}
        sourceToolbar={isWorkspaceHtmlPreviewFile(fileQuery.data) ? (
          <WorkspaceHtmlPreviewToolbar
            viewMode="source"
            onViewModeChange={setFilePreviewMode}
            testIdPrefix="library-live-surface"
          />
        ) : isWorkspaceCsvPreviewFile(fileQuery.data) ? (
          <div className="flex h-10 shrink-0 items-center justify-end border-b border-border px-3">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setFilePreviewMode("preview")}
              aria-label="Show table"
            >
              <Table2 className="h-3.5 w-3.5" aria-hidden />
              Show table
            </button>
          </div>
        ) : undefined}
      />
    ) : (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="library-live-surface-file-preview">
        {isWorkspaceCsvPreviewFile(fileQuery.data) ? (
          <div className="flex h-10 shrink-0 items-center justify-end border-b border-border px-3">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setFilePreviewMode("source")}
              aria-label="Show source"
            >
              <FileCode2 className="h-3.5 w-3.5" aria-hidden />
              Show source
            </button>
          </div>
        ) : null}
        <WorkspaceFilePreview
          file={fileQuery.data}
          organizationId={organizationId}
          mode={filePreviewMode}
          onModeChange={setFilePreviewMode}
          testIdPrefix="library-live-surface"
        />
      </div>
    );
  } else if (target.kind === "library_document" && documentQuery.data) {
    content = (
      <article
        className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-8 py-8"
        data-testid="library-live-surface-document"
      >
        <MarkdownBody className="rudder-library-document-editor rudder-readable-document mx-auto w-full max-w-[880px] text-[15px] leading-7 text-foreground">
          {documentQuery.data.body}
        </MarkdownBody>
      </article>
    );
  } else if (target.kind === "library_directory" && directoryQuery.data) {
    content = (
      <div
        className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto p-3"
        data-testid="library-live-surface-directory"
      >
        <div className="mb-3 px-2">
          <div className="truncate text-sm font-medium text-foreground">
            {directoryQuery.data.directoryPath || "Library root"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {directoryQuery.data.entries.length} item
            {directoryQuery.data.entries.length === 1 ? "" : "s"}
          </div>
        </div>
        <ul className="space-y-0.5 border-t border-border/70 pt-2">
          {directoryQuery.data.entries.map((entry) => {
            const label = entry.displayLabel?.trim() || entry.name;
            const Icon = entry.isDirectory
              ? Folder
              : /\.(?:md|markdown|mdx|txt)$/i.test(entry.path)
                ? FileText
                : FileCode2;
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground"
                  onClick={() => onOpenTarget(
                    entry.isDirectory
                      ? {
                          kind: "library_directory",
                          directoryPath: entry.path,
                          label,
                        }
                      : entry.libraryEntryId
                        ? {
                            kind: "library_entry",
                            entryId: entry.libraryEntryId,
                            label,
                            path: entry.path,
                          }
                        : {
                            kind: "library_file",
                            filePath: entry.path,
                            label: label || fileLabel(entry.path),
                          },
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {entry.isDirectory ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  } else {
    content = unavailable("This Library item is unavailable.");
  }

  return (
    <section
      aria-hidden={!active}
      className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-[color:var(--surface-panel)]"
      data-active={active ? "true" : "false"}
      data-surface={surface}
      data-target-kind={target.kind}
      data-testid="library-live-surface"
    >
      {file && fileOpenTargets.length > 0 ? (
        <div
          className="flex h-11 shrink-0 items-center gap-3 border-b border-border/70 px-4"
          data-testid="library-live-surface-file-toolbar"
        >
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {file.filePath}
          </span>
          <div data-testid="library-live-surface-file-open-selector">
            <WorkspaceFileOpenMenu
              targets={fileOpenTargets}
              openingTargetId={openingTargetId}
              onOpenTarget={(nextTarget) => void openFileTarget(nextTarget)}
              onOpenInLibrary={() => navigate(applyOrganizationPrefix(
                `/library?path=${encodeURIComponent(file.filePath)}`,
                extractOrganizationPrefixFromPath(location.pathname),
              ))}
              testId="library-live-surface-file-open-menu"
            />
          </div>
        </div>
      ) : null}
      {content}
    </section>
  );
}
