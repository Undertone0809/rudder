import { organizationsApi } from "@/api/orgs";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef } from "@/components/MarkdownEditor";
import {
  isWorkspaceMarkdownPreviewFile,
  WorkspaceFilePreview,
  type WorkspaceFilePreviewMode,
} from "@/components/WorkspaceFilePreview";
import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import {
  clearChatSidePanelMarkdownDraft,
  countChatSidePanelMarkdownWords,
  joinChatSidePanelYamlFrontmatter,
  restoreChatSidePanelMarkdownDraft,
  splitChatSidePanelYamlFrontmatter,
  storeChatSidePanelMarkdownDraft,
  type RestoredChatSidePanelMarkdownDraft,
} from "@/pages/Chat.side-panel.helpers";
import type {
  LibraryDocument,
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceFileEntry,
} from "@rudderhq/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  Redo2,
  Undo2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type LibraryLiveSurfaceTarget = Extract<
  SidePanelTarget,
  {
    kind:
      | "library_directory"
      | "library_document"
      | "library_entry"
      | "library_file";
  }
>;

export type LibraryLiveSurfaceKind = "side_panel" | "workbench";

const MARKDOWN_CONFLICT_MESSAGE = "This file changed while you were editing it.";

function basename(path: string, fallback: string) {
  return path.split("/").filter(Boolean).at(-1) ?? fallback;
}

function WorkspaceMarkdownSession({
  file,
  organizationId,
}: {
  file: OrganizationWorkspaceFileDetail;
  organizationId: string;
}) {
  const queryClient = useQueryClient();
  const filePath = file.filePath;
  const serverContent = file.content ?? "";
  const restoredDraftRef = useRef<RestoredChatSidePanelMarkdownDraft | null>(null);
  if (restoredDraftRef.current === null) {
    restoredDraftRef.current = restoreChatSidePanelMarkdownDraft(
      organizationId,
      filePath,
      serverContent,
    );
  }
  const restoredDraft = restoredDraftRef.current;
  const editorRef = useRef<MarkdownEditorRef>(null);
  const syncedContentRef = useRef(restoredDraft.baseContent);
  const latestServerContentRef = useRef(serverContent);
  const draftContentRef = useRef(restoredDraft.content);
  const queuedSaveRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);
  const saveConflictRef = useRef(restoredDraft.conflicted);
  const saveResolutionVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const [draftContent, setDraftContent] = useState(restoredDraft.content);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">(
    restoredDraft.conflicted
      ? "error"
      : restoredDraft.content === serverContent
        ? "saved"
        : "saving",
  );
  const [saveError, setSaveError] = useState<string | null>(
    restoredDraft.conflicted ? MARKDOWN_CONFLICT_MESSAGE : null,
  );
  const [saveConflict, setSaveConflict] = useState(restoredDraft.conflicted);
  const [, setHistoryVersion] = useState(0);

  draftContentRef.current = draftContent;
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
      saveConflictRef.current = false;
      setSaveConflict(false);
      setSaveStatus("saved");
      setSaveError(null);
      clearChatSidePanelMarkdownDraft(organizationId, filePath);
      return;
    }
    if (draftContentRef.current === syncedContentRef.current) {
      syncedContentRef.current = serverContent;
      draftContentRef.current = serverContent;
      setDraftContent(serverContent);
      saveConflictRef.current = false;
      setSaveConflict(false);
      setSaveStatus("saved");
      setSaveError(null);
      clearChatSidePanelMarkdownDraft(organizationId, filePath);
      return;
    }
    queuedSaveRef.current = null;
    saveConflictRef.current = true;
    saveResolutionVersionRef.current += 1;
    setSaveConflict(true);
    setSaveStatus("error");
    setSaveError(MARKDOWN_CONFLICT_MESSAGE);
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
    saveConflictRef.current = false;
    if (mountedRef.current) {
      setSaveConflict(false);
      setSaveError(null);
    }
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
  }, [filePath, organizationId, queryClient]);

  const drainSaveQueue = useCallback(async () => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    try {
      while (queuedSaveRef.current !== null) {
        const content = queuedSaveRef.current;
        const resolutionVersion = saveResolutionVersionRef.current;
        queuedSaveRef.current = null;
        if (saveConflictRef.current) return;
        if (content === syncedContentRef.current) continue;
        if (mountedRef.current) {
          setSaveStatus("saving");
          setSaveError(null);
        }
        try {
          const detail = await organizationsApi.updateWorkspaceFile(
            organizationId,
            filePath,
            { content, expectedContent: syncedContentRef.current },
          );
          if (resolutionVersion !== saveResolutionVersionRef.current) continue;
          acceptSavedDetail(detail, content);
        } catch (error) {
          if (resolutionVersion !== saveResolutionVersionRef.current) continue;
          let latestDetail: OrganizationWorkspaceFileDetail | null = null;
          try {
            latestDetail = await organizationsApi.readWorkspaceFile(
              organizationId,
              filePath,
            );
          } catch {
            // Keep the original write error when the reconciliation read fails.
          }
          if (resolutionVersion !== saveResolutionVersionRef.current) continue;
          if (latestDetail) {
            latestServerContentRef.current = latestDetail.content ?? "";
            queryClient.setQueryData(
              queryKeys.organizations.workspaceFile(organizationId, filePath),
              latestDetail,
            );
          }
          if (latestDetail?.content === content) {
            acceptSavedDetail(latestDetail, content);
            continue;
          }
          if (latestDetail && latestDetail.content !== syncedContentRef.current) {
            queuedSaveRef.current = null;
            saveConflictRef.current = true;
            storeChatSidePanelMarkdownDraft(
              organizationId,
              filePath,
              syncedContentRef.current,
              draftContentRef.current,
            );
          }
          if (mountedRef.current) {
            const conflicted = saveConflictRef.current;
            setSaveConflict(conflicted);
            setSaveStatus("error");
            setSaveError(
              conflicted
                ? MARKDOWN_CONFLICT_MESSAGE
                : error instanceof Error
                  ? error.message
                  : "Could not save this file.",
            );
          }
          return;
        }
      }
      if (mountedRef.current) {
        setSaveStatus(
          draftContentRef.current === syncedContentRef.current
            ? "saved"
            : "saving",
        );
      }
    } finally {
      saveInFlightRef.current = false;
      if (queuedSaveRef.current !== null && !saveConflictRef.current) {
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
      draftContent,
    );
    if (saveConflictRef.current) return undefined;
    if (draftContent === syncedContentRef.current) {
      setSaveStatus(
        saveInFlightRef.current || queuedSaveRef.current !== null
          ? "saving"
          : "saved",
      );
      setSaveError(null);
      return undefined;
    }
    const timeout = window.setTimeout(() => enqueueSave(draftContent), 700);
    return () => window.clearTimeout(timeout);
  }, [draftContent, enqueueSave, filePath, organizationId]);

  const handleDraftChange = (content: string) => {
    draftContentRef.current = content;
    setDraftContent(content);
    setSaveStatus(saveConflictRef.current ? "error" : "saving");
    if (!saveConflictRef.current) setSaveError(null);
    setHistoryVersion((current) => current + 1);
  };

  const useLatestServerContent = () => {
    const content = latestServerContentRef.current;
    saveResolutionVersionRef.current += 1;
    syncedContentRef.current = content;
    draftContentRef.current = content;
    queuedSaveRef.current = null;
    saveConflictRef.current = false;
    setDraftContent(content);
    setSaveConflict(false);
    setSaveStatus("saved");
    setSaveError(null);
    clearChatSidePanelMarkdownDraft(organizationId, filePath);
  };

  const keepLocalDraft = () => {
    saveResolutionVersionRef.current += 1;
    syncedContentRef.current = latestServerContentRef.current;
    saveConflictRef.current = false;
    setSaveConflict(false);
    setSaveStatus("saving");
    setSaveError(null);
    enqueueSave(draftContentRef.current);
  };

  const markdownParts = splitChatSidePanelYamlFrontmatter(draftContent);
  const wordCount = countChatSidePanelMarkdownWords(markdownParts.body);
  const canUndo = editorRef.current?.canUndo?.() ?? false;
  const canRedo = editorRef.current?.canRedo?.() ?? false;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-testid="library-live-markdown-editor"
    >
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-5 pb-20 pt-5">
        {markdownParts.frontmatter !== null ? (
          <details className="group mb-6 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-page)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
              <span>Frontmatter</span>
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            </summary>
            <textarea
              aria-label="Frontmatter"
              className="block min-h-28 w-full resize-y border-t border-[color:var(--border-soft)] bg-transparent px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none"
              spellCheck={false}
              value={markdownParts.frontmatter}
              onChange={(event) => handleDraftChange(
                joinChatSidePanelYamlFrontmatter(
                  event.currentTarget.value,
                  markdownParts.separator,
                  markdownParts.body,
                ),
              )}
            />
          </details>
        ) : null}
        <MarkdownEditor
          ref={editorRef}
          engine="codemirror"
          documentIdentity={`library-file:${filePath}`}
          value={markdownParts.body}
          onChange={(body) => handleDraftChange(
            joinChatSidePanelYamlFrontmatter(
              markdownParts.frontmatter,
              markdownParts.separator,
              body,
            ),
          )}
          bordered={false}
          placeholder="Write in Markdown..."
          contentClassName="rudder-library-document-editor min-h-[420px] text-[15px] leading-7 text-foreground"
        />
      </div>
      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex min-w-0 items-end justify-between gap-3">
        <div
          className={cn(
            "pointer-events-auto flex min-h-8 min-w-0 items-center gap-2 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-2.5 text-xs shadow-sm",
            saveStatus === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          role={saveStatus === "error" ? "alert" : "status"}
          title={saveError ?? undefined}
        >
          <span className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            saveStatus === "error"
              ? "bg-destructive"
              : saveStatus === "saving"
                ? "bg-[color:var(--accent-strong)]"
                : "bg-emerald-500",
          )} />
          <span className="truncate">
            {saveConflict
              ? "Conflict"
              : saveStatus === "error"
                ? "Save failed"
                : saveStatus === "saving"
                  ? "Saving"
                  : "Saved"}
            {` · ${wordCount.toLocaleString()} ${wordCount === 1 ? "word" : "words"}`}
          </span>
          {saveConflict ? (
            <>
              <button
                type="button"
                className="shrink-0 font-medium text-foreground underline underline-offset-2"
                onClick={keepLocalDraft}
              >
                Keep mine
              </button>
              <button
                type="button"
                className="shrink-0 font-medium text-foreground underline underline-offset-2"
                onClick={useLatestServerContent}
              >
                Use latest
              </button>
            </>
          ) : saveStatus === "error" ? (
            <button
              type="button"
              className="shrink-0 font-medium text-foreground underline underline-offset-2"
              onClick={() => enqueueSave(draftContentRef.current)}
            >
              Retry
            </button>
          ) : null}
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-0.5 shadow-sm">
          <button
            type="button"
            aria-label="Undo Markdown edit"
            disabled={!canUndo}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-[color:var(--surface-active)] disabled:pointer-events-none disabled:opacity-35"
            onClick={() => {
              editorRef.current?.undo?.();
              setHistoryVersion((current) => current + 1);
            }}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Redo Markdown edit"
            disabled={!canRedo}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-[color:var(--surface-active)] disabled:pointer-events-none disabled:opacity-35"
            onClick={() => {
              editorRef.current?.redo?.();
              setHistoryVersion((current) => current + 1);
            }}
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceFileSurface({
  file,
  organizationId,
}: {
  file: OrganizationWorkspaceFileDetail;
  organizationId: string;
}) {
  const [previewMode, setPreviewMode] = useState<WorkspaceFilePreviewMode>("preview");
  const markdown = isWorkspaceMarkdownPreviewFile(file);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="library-live-file">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--border-soft)] px-4">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium text-foreground">
          {basename(file.filePath, "Library file")}
        </span>
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
          {file.filePath}
        </span>
      </div>
      {markdown && !file.truncated ? (
        <WorkspaceMarkdownSession
          key={`${organizationId}:${file.filePath}`}
          file={file}
          organizationId={organizationId}
        />
      ) : (
        <>
          {markdown && file.truncated ? (
            <div
              className="shrink-0 border-b border-[color:var(--border-soft)] px-4 py-2 text-xs text-muted-foreground"
              role="status"
            >
              {file.message ?? "This file is too large to edit here."}
            </div>
          ) : null}
          <WorkspaceFilePreview
            file={file}
            organizationId={organizationId}
            mode={previewMode}
            onModeChange={setPreviewMode}
            testIdPrefix="library-live"
          />
        </>
      )}
    </div>
  );
}

function DirectoryEntry({
  entry,
  onOpenTarget,
}: {
  entry: OrganizationWorkspaceFileEntry;
  onOpenTarget: (target: SidePanelTarget) => void;
}) {
  const Icon = entry.isDirectory ? Folder : FileCode2;
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        onClick={() => {
          if (entry.isDirectory) {
            onOpenTarget({
              kind: "library_directory",
              directoryPath: entry.path,
              label: entry.displayLabel || entry.name,
            });
          } else {
            onOpenTarget({
              kind: "library_file",
              filePath: entry.path,
              label: entry.displayLabel || entry.name,
            });
          }
        }}
      >
        {entry.isDirectory
          ? <ChevronRight className="h-3.5 w-3.5" />
          : <span className="h-3.5 w-3.5" />}
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{entry.displayLabel || entry.name}</span>
      </button>
    </li>
  );
}

function DirectorySurface({
  entries,
  label,
  onOpenTarget,
}: {
  entries: OrganizationWorkspaceFileEntry[];
  label: string;
  onOpenTarget: (target: SidePanelTarget) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="library-live-directory">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--border-soft)] px-4">
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium text-foreground">{label}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {entries.length} {entries.length === 1 ? "item" : "items"}
        </span>
      </div>
      <ul className="scrollbar-auto-hide min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {entries.length > 0
          ? entries.map((entry) => (
              <DirectoryEntry
                key={entry.path}
                entry={entry}
                onOpenTarget={onOpenTarget}
              />
            ))
          : (
              <li className="px-2 py-3 text-sm text-muted-foreground">
                This folder is empty or unavailable.
              </li>
            )}
      </ul>
    </div>
  );
}

function LegacyDocumentSurface({ document }: { document: LibraryDocument }) {
  const title = document.title?.trim() || `Document ${document.id.slice(0, 8)}`;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="library-live-document">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--border-soft)] px-4">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          r{document.latestRevisionNumber}
        </span>
      </div>
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto w-full max-w-[880px] px-8 py-8">
          <MarkdownBody className="rudder-library-document-editor text-[15px] leading-7 text-foreground">
            {document.body}
          </MarkdownBody>
        </article>
      </div>
    </div>
  );
}

export function LibraryLiveSurface({
  active,
  organizationId,
  surface,
  target,
  onOpenTarget,
}: {
  active: boolean;
  organizationId: string;
  surface: LibraryLiveSurfaceKind;
  target: LibraryLiveSurfaceTarget;
  onOpenTarget: (target: SidePanelTarget) => void;
}) {
  const entryQuery = useQuery({
    queryKey: queryKeys.organizations.libraryEntry(
      organizationId,
      target.kind === "library_entry" ? target.entryId : "",
    ),
    queryFn: () => organizationsApi.getLibraryEntry(
      organizationId,
      (target as Extract<LibraryLiveSurfaceTarget, { kind: "library_entry" }>).entryId,
    ),
    enabled: active && target.kind === "library_entry",
    refetchOnWindowFocus: false,
  });
  const filePath = target.kind === "library_file"
    ? target.filePath
    : target.kind === "library_entry"
      ? entryQuery.data?.currentPath ?? target.path
      : null;
  const fileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFile(organizationId, filePath ?? ""),
    queryFn: () => organizationsApi.readWorkspaceFile(organizationId, filePath!),
    enabled: active && Boolean(filePath),
    refetchOnWindowFocus: false,
  });
  const directoryQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(
      organizationId,
      target.kind === "library_directory" ? target.directoryPath : "",
    ),
    queryFn: () => organizationsApi.listWorkspaceFiles(
      organizationId,
      (target as Extract<LibraryLiveSurfaceTarget, { kind: "library_directory" }>).directoryPath,
    ),
    enabled: active && target.kind === "library_directory",
    refetchOnWindowFocus: false,
  });
  const documentQuery = useQuery({
    queryKey: queryKeys.organizations.libraryDocument(
      organizationId,
      target.kind === "library_document" ? target.documentId : "",
    ),
    queryFn: () => organizationsApi.getLibraryDocument(
      organizationId,
      (target as Extract<LibraryLiveSurfaceTarget, { kind: "library_document" }>).documentId,
    ),
    enabled: active && target.kind === "library_document",
    refetchOnWindowFocus: false,
  });

  const error = entryQuery.error
    ?? fileQuery.error
    ?? directoryQuery.error
    ?? documentQuery.error;
  const pending = (target.kind === "library_entry" && entryQuery.isPending)
    || (Boolean(filePath) && fileQuery.isPending)
    || (target.kind === "library_directory" && directoryQuery.isPending)
    || (target.kind === "library_document" && documentQuery.isPending);

  return (
    <div
      className="h-full min-h-0"
      data-testid="library-live-surface"
      data-library-surface={surface}
    >
      {error ? (
        <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive" role="alert">
          {error instanceof Error ? error.message : "This Library item is unavailable."}
        </div>
      ) : pending ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading Library item…
        </div>
      ) : target.kind === "library_document" && documentQuery.data ? (
        <LegacyDocumentSurface document={documentQuery.data} />
      ) : target.kind === "library_directory" && directoryQuery.data ? (
        <DirectorySurface
          entries={directoryQuery.data.entries}
          label={target.label}
          onOpenTarget={onOpenTarget}
        />
      ) : fileQuery.data ? (
        <WorkspaceFileSurface
          file={fileQuery.data}
          organizationId={organizationId}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          This Library item is unavailable.
        </div>
      )}
    </div>
  );
}
