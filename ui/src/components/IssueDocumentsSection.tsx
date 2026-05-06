import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@rudderhq/shared";
import { useLocation } from "@/lib/router";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { useAutosaveIndicator } from "../hooks/useAutosaveIndicator";
import { extractDocumentOutline, type DocumentOutlineItem } from "../lib/document-outline";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { semanticNoticeToneClasses, semanticTextToneClasses } from "@/components/ui/semanticTones";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Copy, Download, FileText, Maximize2, MoreHorizontal, Plus, Trash2, X } from "lucide-react";

type DraftState = {
  key: string;
  title: string;
  body: string;
  baseRevisionId: string | null;
  isNew: boolean;
};

type DocumentConflictState = {
  key: string;
  serverDocument: IssueDocument;
  localDraft: DraftState;
  showRemote: boolean;
};

const DOCUMENT_AUTOSAVE_DEBOUNCE_MS = 900;
const getFoldedDocumentsStorageKey = (issueId: string) => `rudder:issue-document-folds:${issueId}`;

function loadFoldedDocumentKeys(issueId: string) {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(getFoldedDocumentsStorageKey(issueId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function saveFoldedDocumentKeys(issueId: string, keys: string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(getFoldedDocumentsStorageKey(issueId), JSON.stringify(keys));
}

function renderBody(body: string, className?: string) {
  return <MarkdownBody className={className}>{body}</MarkdownBody>;
}

function isPlanKey(key: string) {
  return key.trim().toLowerCase() === "plan";
}

function titleCaseWords(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function stripMarkdownSyntax(line: string) {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/^\>\s+/, "")
    .replace(/`+/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim();
}

function inferDocumentTitle(title: string | null | undefined, body: string, key?: string) {
  const explicitTitle = title?.trim();
  if (explicitTitle) return explicitTitle;

  const firstMeaningfulLine = body
    .split(/\r?\n/)
    .map(stripMarkdownSyntax)
    .find((line) => line.length > 0);
  if (firstMeaningfulLine) {
    return firstMeaningfulLine.slice(0, 80);
  }

  if (key && !isPlanKey(key)) {
    return titleCaseWords(key);
  }

  return "Untitled document";
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "note";
}

function buildDocumentKey(title: string, body: string, existingKeys: string[]) {
  const takenKeys = new Set(existingKeys);
  const rawBaseKey = slugifyDocumentKey(inferDocumentTitle(title, body));
  const baseKey = rawBaseKey === "plan" ? "note" : rawBaseKey;
  let candidate = baseKey;
  let suffix = 2;

  while (takenKeys.has(candidate)) {
    candidate = `${baseKey}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function displayDocumentTitle(doc: Pick<IssueDocument, "title" | "body" | "key">) {
  if (isPlanKey(doc.key)) return "Plan";
  return inferDocumentTitle(doc.title, doc.body, doc.key);
}

function isDocumentConflictError(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}

function downloadDocumentFile(key: string, body: string) {
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${key}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function IssueDocumentsSection({
  issue,
  canDeleteDocuments,
  mentions,
  imageUploadHandler,
  extraActions,
  onFocusDocument,
  onFocusNewDocument,
}: {
  issue: Issue;
  canDeleteDocuments: boolean;
  mentions?: MentionOption[];
  imageUploadHandler?: (file: File) => Promise<string>;
  extraActions?: ReactNode;
  onFocusDocument?: (key: string) => void;
  onFocusNewDocument?: () => void;
}) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [documentConflict, setDocumentConflict] = useState<DocumentConflictState | null>(null);
  const [foldedDocumentKeys, setFoldedDocumentKeys] = useState<string[]>(() => loadFoldedDocumentKeys(issue.id));
  const [autosaveDocumentKey, setAutosaveDocumentKey] = useState<string | null>(null);
  const [copiedDocumentKey, setCopiedDocumentKey] = useState<string | null>(null);
  const [highlightDocumentKey, setHighlightDocumentKey] = useState<string | null>(null);
  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedDocumentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasScrolledToHashRef = useRef(false);
  const {
    state: autosaveState,
    markDirty,
    reset,
    runSave,
  } = useAutosaveIndicator();

  const { data: documents } = useQuery({
    queryKey: queryKeys.issues.documents(issue.id),
    queryFn: () => issuesApi.listDocuments(issue.id),
  });

  const invalidateIssueDocuments = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
  };

  const upsertDocument = useMutation({
    mutationFn: async (nextDraft: DraftState) =>
      issuesApi.upsertDocument(issue.id, nextDraft.key, {
        title: isPlanKey(nextDraft.key) ? null : nextDraft.title.trim() || null,
        format: "markdown",
        body: nextDraft.body,
        baseRevisionId: nextDraft.baseRevisionId,
      }),
  });

  const deleteDocument = useMutation({
    mutationFn: (key: string) => issuesApi.deleteDocument(issue.id, key),
    onSuccess: () => {
      setError(null);
      setConfirmDeleteKey(null);
      invalidateIssueDocuments();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to delete document");
    },
  });

  const sortedDocuments = useMemo(() => {
    return [...(documents ?? [])].sort((a, b) => {
      if (a.key === "plan" && b.key !== "plan") return -1;
      if (a.key !== "plan" && b.key === "plan") return 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [documents]);

  const hasRealPlan = sortedDocuments.some((doc) => doc.key === "plan");
  const isEmpty = sortedDocuments.length === 0 && !issue.legacyPlanDocument;

  const resetAutosaveState = useCallback(() => {
    setAutosaveDocumentKey(null);
    reset();
  }, [reset]);

  const markDocumentDirty = useCallback((key: string) => {
    setAutosaveDocumentKey(key);
    markDirty();
  }, [markDirty]);

  const beginNewDocument = () => {
    if (onFocusNewDocument) {
      onFocusNewDocument();
      return;
    }
    resetAutosaveState();
    setDocumentConflict(null);
    setDraft({
      key: "",
      title: "",
      body: "",
      baseRevisionId: null,
      isNew: true,
    });
    setError(null);
  };

  const beginEdit = (key: string) => {
    const doc = sortedDocuments.find((entry) => entry.key === key);
    if (!doc) return;
    const conflictedDraft = documentConflict?.key === key ? documentConflict.localDraft : null;
    setFoldedDocumentKeys((current) => current.filter((entry) => entry !== key));
    resetAutosaveState();
    setDocumentConflict((current) => current?.key === key ? current : null);
    setDraft({
      key: conflictedDraft?.key ?? doc.key,
      title: conflictedDraft?.title ?? doc.title ?? "",
      body: conflictedDraft?.body ?? doc.body,
      baseRevisionId: conflictedDraft?.baseRevisionId ?? doc.latestRevisionId,
      isNew: false,
    });
    setError(null);
  };

  const cancelDraft = () => {
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    resetAutosaveState();
    setDocumentConflict(null);
    setDraft(null);
    setError(null);
  };

  const commitDraft = useCallback(async (
    currentDraft: DraftState | null,
    options?: { clearAfterSave?: boolean; trackAutosave?: boolean; overrideConflict?: boolean },
  ) => {
    if (!currentDraft || upsertDocument.isPending) return false;
    const normalizedBody = currentDraft.body.trim();
    const normalizedKey = currentDraft.isNew
      ? buildDocumentKey(currentDraft.title, currentDraft.body, sortedDocuments.map((doc) => doc.key))
      : currentDraft.key.trim().toLowerCase();
    const normalizedTitle = inferDocumentTitle(
      currentDraft.title,
      currentDraft.body,
      currentDraft.isNew ? undefined : normalizedKey,
    );
    const activeConflict = documentConflict?.key === normalizedKey ? documentConflict : null;

    if (activeConflict && !options?.overrideConflict) {
      if (options?.trackAutosave) {
        resetAutosaveState();
      }
      return false;
    }

    if (!normalizedBody) {
      if (currentDraft.isNew) {
        setError("Add some content before creating the document");
      } else {
        setError("Document body cannot be empty");
      }
      if (options?.trackAutosave) {
        resetAutosaveState();
      }
      return false;
    }

    const existing = sortedDocuments.find((doc) => doc.key === normalizedKey);
    if (
      !currentDraft.isNew &&
      existing &&
      existing.body === currentDraft.body &&
      (existing.title ?? "") === currentDraft.title
    ) {
      if (options?.clearAfterSave) {
        setDraft((value) => (value?.key === normalizedKey ? null : value));
      }
      if (options?.trackAutosave) {
        resetAutosaveState();
      }
      return true;
    }

    const save = async () => {
      const saved = await upsertDocument.mutateAsync({
        ...currentDraft,
        key: normalizedKey,
        title: isPlanKey(normalizedKey) ? "" : normalizedTitle,
        body: currentDraft.body,
        baseRevisionId: options?.overrideConflict
          ? activeConflict?.serverDocument.latestRevisionId ?? currentDraft.baseRevisionId
          : currentDraft.baseRevisionId,
      });
      setError(null);
      setDocumentConflict((current) => current?.key === normalizedKey ? null : current);
      setDraft((value) => {
        if (!value) return value;
        const isCurrentDraft = currentDraft.isNew
          ? value.isNew && value.key === currentDraft.key
          : value.key === normalizedKey;
        if (!isCurrentDraft) return value;
        if (options?.clearAfterSave) return null;
        return {
          key: saved.key,
          title: saved.title ?? normalizedTitle,
          body: saved.body,
          baseRevisionId: saved.latestRevisionId,
          isNew: false,
        };
      });
      invalidateIssueDocuments();
    };

    try {
      if (options?.trackAutosave) {
        setAutosaveDocumentKey(normalizedKey);
        await runSave(save);
      } else {
        await save();
      }
      return true;
    } catch (err) {
      if (isDocumentConflictError(err)) {
        try {
          const latestDocument = await issuesApi.getDocument(issue.id, normalizedKey);
          setDocumentConflict({
            key: normalizedKey,
            serverDocument: latestDocument,
            localDraft: {
              key: normalizedKey,
              title: isPlanKey(normalizedKey) ? "" : normalizedTitle,
              body: currentDraft.body,
              baseRevisionId: currentDraft.baseRevisionId,
              isNew: false,
            },
            showRemote: true,
          });
          setFoldedDocumentKeys((current) => current.filter((key) => key !== normalizedKey));
          setError(null);
          resetAutosaveState();
          return false;
        } catch {
          setError("Document changed remotely and the latest version could not be loaded");
          return false;
        }
      }
      setError(err instanceof Error ? err.message : "Failed to save document");
      return false;
    }
  }, [documentConflict, invalidateIssueDocuments, issue.id, resetAutosaveState, runSave, sortedDocuments, upsertDocument]);

  const reloadDocumentFromServer = useCallback((key: string) => {
    if (documentConflict?.key !== key) return;
    const serverDocument = documentConflict.serverDocument;
    setDraft({
      key: serverDocument.key,
      title: serverDocument.title ?? "",
      body: serverDocument.body,
      baseRevisionId: serverDocument.latestRevisionId,
      isNew: false,
    });
    setDocumentConflict(null);
    resetAutosaveState();
    setError(null);
  }, [documentConflict, resetAutosaveState]);

  const overwriteDocumentFromDraft = useCallback(async (key: string) => {
    if (documentConflict?.key !== key) return;
    const sourceDraft =
      draft && draft.key === key && !draft.isNew
        ? draft
        : documentConflict.localDraft;
    await commitDraft(
      {
        ...sourceDraft,
        baseRevisionId: documentConflict.serverDocument.latestRevisionId,
      },
      {
        clearAfterSave: false,
        trackAutosave: true,
        overrideConflict: true,
      },
    );
  }, [commitDraft, documentConflict, draft]);

  const keepConflictedDraft = useCallback((key: string) => {
    if (documentConflict?.key !== key) return;
    setDraft(documentConflict.localDraft);
    setDocumentConflict((current) =>
      current?.key === key
        ? { ...current, showRemote: false }
        : current,
    );
    setError(null);
  }, [documentConflict]);

  const copyDocumentBody = useCallback(async (key: string, body: string) => {
    try {
      await navigator.clipboard.writeText(body);
      setCopiedDocumentKey(key);
      if (copiedDocumentTimerRef.current) {
        clearTimeout(copiedDocumentTimerRef.current);
      }
      copiedDocumentTimerRef.current = setTimeout(() => {
        setCopiedDocumentKey((current) => current === key ? null : current);
      }, 1400);
    } catch {
      setError("Could not copy document");
    }
  }, []);

  const handleDraftBlur = async (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    await commitDraft(draft, { clearAfterSave: true, trackAutosave: true });
  };

  const handleDraftKeyDown = async (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDraft();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      await commitDraft(draft, { clearAfterSave: false, trackAutosave: true });
    }
  };

  const createDraftDocument = useCallback(async (options?: { trackAutosave?: boolean }) => {
    const saved = await commitDraft(draft, {
      clearAfterSave: true,
      trackAutosave: options?.trackAutosave ?? false,
    });
    if (saved) {
      resetAutosaveState();
    }
  }, [commitDraft, draft]);

  useEffect(() => {
    setFoldedDocumentKeys(loadFoldedDocumentKeys(issue.id));
  }, [issue.id]);

  useEffect(() => {
    hasScrolledToHashRef.current = false;
  }, [issue.id, location.hash]);

  useEffect(() => {
    const validKeys = new Set(sortedDocuments.map((doc) => doc.key));
    setFoldedDocumentKeys((current) => {
      const next = current.filter((key) => validKeys.has(key));
      if (next.length !== current.length) {
        saveFoldedDocumentKeys(issue.id, next);
      }
      return next;
    });
  }, [issue.id, sortedDocuments]);

  useEffect(() => {
    saveFoldedDocumentKeys(issue.id, foldedDocumentKeys);
  }, [foldedDocumentKeys, issue.id]);

  useEffect(() => {
    if (!documentConflict) return;
    const latest = sortedDocuments.find((doc) => doc.key === documentConflict.key);
    if (!latest || latest.latestRevisionId === documentConflict.serverDocument.latestRevisionId) return;
    setDocumentConflict((current) =>
      current?.key === latest.key
        ? { ...current, serverDocument: latest }
        : current,
    );
  }, [documentConflict, sortedDocuments]);

  useEffect(() => {
    const hash = location.hash;
    if (!hash.startsWith("#document-")) return;
    const documentKey = decodeURIComponent(hash.slice("#document-".length));
    const targetExists = sortedDocuments.some((doc) => doc.key === documentKey)
      || (documentKey === "plan" && Boolean(issue.legacyPlanDocument));
    if (!targetExists || hasScrolledToHashRef.current) return;
    setFoldedDocumentKeys((current) => current.filter((key) => key !== documentKey));
    const element = document.getElementById(`document-${documentKey}`);
    if (!element) return;
    hasScrolledToHashRef.current = true;
    setHighlightDocumentKey(documentKey);
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlightDocumentKey((current) => current === documentKey ? null : current), 3000);
    return () => clearTimeout(timer);
  }, [issue.legacyPlanDocument, location.hash, sortedDocuments]);

  useEffect(() => {
    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      if (copiedDocumentTimerRef.current) {
        clearTimeout(copiedDocumentTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!draft || draft.isNew) return;
    if (documentConflict?.key === draft.key) return;
    const existing = sortedDocuments.find((doc) => doc.key === draft.key);
    if (!existing) return;
    const hasChanges =
      existing.body !== draft.body ||
      (existing.title ?? "") !== draft.title;
    if (!hasChanges) {
      if (autosaveState !== "saved") {
        resetAutosaveState();
      }
      return;
    }
    markDocumentDirty(draft.key);
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    autosaveDebounceRef.current = setTimeout(() => {
      void commitDraft(draft, { clearAfterSave: false, trackAutosave: true });
    }, DOCUMENT_AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
    };
  }, [autosaveState, commitDraft, documentConflict, draft, markDocumentDirty, resetAutosaveState, sortedDocuments]);

  const documentBodyShellClassName = "mt-3 overflow-hidden rounded-md";
  const documentBodyPaddingClassName = "";
  const documentBodyContentClassName = "rudder-edit-in-place-content min-h-[220px] text-[15px] leading-7";
  const toggleFoldedDocument = (key: string) => {
    setFoldedDocumentKeys((current) =>
      current.includes(key)
        ? current.filter((entry) => entry !== key)
        : [...current, key],
    );
  };

  return (
    <div className="space-y-3">
      {isEmpty && !draft?.isNew ? (
        <div className="flex items-center justify-end gap-2 min-w-0">
          {extraActions}
          <Button variant="quiet" size="xs" onClick={beginNewDocument} className="shrink-0">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            <span className="hidden sm:inline">New document</span>
            <span className="sm:hidden">New</span>
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 min-w-0">
          <h3 className="text-sm font-medium text-muted-foreground shrink-0">Documents</h3>
          <div className="flex items-center gap-2 min-w-0">
            {extraActions}
            <Button variant="quiet" size="xs" onClick={beginNewDocument} className="shrink-0">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              <span className="hidden sm:inline">New document</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {draft?.isNew && (
        <div
          className="space-y-3 rounded-lg border border-border bg-accent/10 p-3"
          onBlurCapture={handleDraftBlur}
          onKeyDown={handleDraftKeyDown}
        >
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={draft.title}
              onChange={(event) =>
                setDraft((current) => current ? { ...current, title: event.target.value } : current)
              }
              placeholder="Document title"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              title="Expand editor"
              aria-label="Expand editor"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onFocusNewDocument?.()}
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
          <MarkdownEditor
            value={draft.body}
            onChange={(body) =>
              setDraft((current) => current ? { ...current, body } : current)
            }
            placeholder="Write the document..."
            bordered={false}
            className="bg-transparent"
            contentClassName="min-h-[220px] text-[15px] leading-7"
            mentions={mentions}
            imageUploadHandler={imageUploadHandler}
            onSubmit={() => void createDraftDocument()}
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={cancelDraft}>
              <X className="mr-1.5 h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void createDraftDocument()}
              disabled={upsertDocument.isPending}
            >
              {upsertDocument.isPending ? "Saving..." : "Create"}
            </Button>
          </div>
        </div>
      )}

      {!hasRealPlan && issue.legacyPlanDocument ? (
        <div
          id="document-plan"
          className={cn(
            "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 transition-colors duration-1000",
            highlightDocumentKey === "plan" && "border-primary/50 bg-primary/5",
          )}
        >
          <div className="mb-2 flex items-center gap-2">
            <FileText className="h-4 w-4 text-amber-600" />
            <span className="rounded-full border border-amber-500/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">
              PLAN
            </span>
          </div>
          <div className={documentBodyPaddingClassName}>
            {renderBody(issue.legacyPlanDocument.body, documentBodyContentClassName)}
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        {sortedDocuments.map((doc) => {
          const activeDraft = draft?.key === doc.key && !draft.isNew ? draft : null;
          const activeConflict = documentConflict?.key === doc.key ? documentConflict : null;
          const isFolded = foldedDocumentKeys.includes(doc.key);
          const title = activeDraft
            ? inferDocumentTitle(activeDraft.title, activeDraft.body, doc.key)
            : displayDocumentTitle(doc);

          return (
            <div
              key={doc.id}
              id={`document-${doc.key}`}
              className={cn(
                "rounded-lg border border-border p-3 transition-colors duration-1000",
                highlightDocumentKey === doc.key && "border-primary/50 bg-primary/5",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      type="button"
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                      onClick={() => toggleFoldedDocument(doc.key)}
                      aria-label={isFolded ? `Expand ${title}` : `Collapse ${title}`}
                      aria-expanded={!isFolded}
                    >
                      {isFolded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <p className="truncate text-sm font-medium">{title}</p>
                  </div>
                  <div className="mt-1 flex items-center gap-2 pl-7">
                    <a
                      href={`#document-${encodeURIComponent(doc.key)}`}
                      className="truncate text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:underline"
                    >
                      rev {doc.latestRevisionNumber} • updated {relativeTime(doc.updatedAt)}
                    </a>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    title="Expand editor"
                    aria-label="Expand editor"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onFocusDocument?.(doc.key);
                    }}
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      "text-muted-foreground transition-colors",
                      copiedDocumentKey === doc.key && "text-foreground",
                    )}
                    title={copiedDocumentKey === doc.key ? "Copied" : "Copy document"}
                    onClick={() => void copyDocumentBody(doc.key, activeDraft?.body ?? doc.body)}
                  >
                    {copiedDocumentKey === doc.key ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground"
                        title="Document actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => downloadDocumentFile(doc.key, activeDraft?.body ?? doc.body)}
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download document
                      </DropdownMenuItem>
                      {canDeleteDocuments ? <DropdownMenuSeparator /> : null}
                      {canDeleteDocuments ? (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setConfirmDeleteKey(doc.key)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete document
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {!isFolded ? (
                <div
                  className="mt-3 space-y-3"
                  onFocusCapture={() => {
                    if (!activeDraft) {
                      beginEdit(doc.key);
                    }
                  }}
                  onBlurCapture={async (event) => {
                    if (activeDraft) {
                      await handleDraftBlur(event);
                    }
                  }}
                  onKeyDown={async (event) => {
                    if (activeDraft) {
                      await handleDraftKeyDown(event);
                    }
                  }}
                >
                  {activeConflict && (
                    <div
                      className={cn(
                        "rounded-md border px-3 py-3",
                        semanticNoticeToneClasses.warn,
                      )}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <p className={cn("text-sm font-medium", semanticTextToneClasses.warn)}>Out of date</p>
                          <p className="text-xs text-muted-foreground">
                            This document changed while you were editing. Your local draft is preserved and autosave is paused.
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setDocumentConflict((current) =>
                                current?.key === doc.key
                                  ? { ...current, showRemote: !current.showRemote }
                                  : current,
                              )
                            }
                          >
                            {activeConflict.showRemote ? "Hide remote" : "Review remote"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => keepConflictedDraft(doc.key)}
                          >
                            Keep my draft
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => reloadDocumentFromServer(doc.key)}
                          >
                            Reload remote
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => void overwriteDocumentFromDraft(doc.key)}
                            disabled={upsertDocument.isPending}
                          >
                            {upsertDocument.isPending ? "Saving..." : "Overwrite remote"}
                          </Button>
                        </div>
                      </div>
                      {activeConflict.showRemote && (
                        <div className="mt-3 rounded-md border border-border/70 bg-background/60 p-3">
                          <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span>Remote revision {activeConflict.serverDocument.latestRevisionNumber}</span>
                            <span>•</span>
                            <span>updated {relativeTime(activeConflict.serverDocument.updatedAt)}</span>
                          </div>
                          <p className="mb-2 text-sm font-medium">
                            {displayDocumentTitle(activeConflict.serverDocument)}
                          </p>
                          {renderBody(activeConflict.serverDocument.body, "text-[14px] leading-7")}
                        </div>
                      )}
                    </div>
                  )}
                  {activeDraft && !isPlanKey(doc.key) && (
                    <Input
                      value={activeDraft.title}
                      onChange={(event) => {
                        markDocumentDirty(doc.key);
                        setDraft((current) => current ? { ...current, title: event.target.value } : current);
                      }}
                      placeholder="Document title"
                    />
                  )}
                  <div
                    className={`${documentBodyShellClassName} ${documentBodyPaddingClassName} ${
                      activeDraft ? "" : "hover:bg-accent/10"
                    }`}
                  >
                    <MarkdownEditor
                      value={activeDraft?.body ?? doc.body}
                      onChange={(body) => {
                        markDocumentDirty(doc.key);
                        setDraft((current) => {
                          if (current && current.key === doc.key && !current.isNew) {
                            return { ...current, body };
                          }
                          return {
                            key: doc.key,
                            title: doc.title ?? title,
                            body,
                            baseRevisionId: doc.latestRevisionId,
                            isNew: false,
                          };
                        });
                      }}
                      placeholder="Write the document..."
                      bordered={false}
                      className="bg-transparent"
                      contentClassName={documentBodyContentClassName}
                      mentions={mentions}
                      imageUploadHandler={imageUploadHandler}
                      onSubmit={() => void commitDraft(activeDraft ?? draft, { clearAfterSave: false, trackAutosave: true })}
                    />
                  </div>
                  <div className="flex min-h-4 items-center justify-end px-1">
                    <span
                      className={`text-[11px] transition-opacity duration-150 ${
                        activeConflict
                          ? "text-amber-300"
                          : autosaveState === "error"
                            ? "text-destructive"
                            : "text-muted-foreground"
                      } ${activeDraft ? "opacity-100" : "opacity-0"}`}
                    >
                      {activeDraft
                        ? activeConflict
                          ? "Out of date"
                          : autosaveDocumentKey === doc.key
                            ? autosaveState === "saving"
                              ? "Autosaving..."
                              : autosaveState === "saved"
                                ? "Saved"
                                : autosaveState === "error"
                                  ? "Could not save"
                                  : ""
                            : ""
                        : ""}
                    </span>
                  </div>
                </div>
              ) : null}

              {confirmDeleteKey === doc.key && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3">
                  <p className="text-sm text-destructive font-medium">
                    Delete this document? This cannot be undone.
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDeleteKey(null)}
                      disabled={deleteDocument.isPending}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => deleteDocument.mutate(doc.key)}
                      disabled={deleteDocument.isPending}
                    >
                      {deleteDocument.isPending ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}

export type IssueDocumentFocusTarget =
  | { kind: "new" }
  | { kind: "existing"; key: string };

export function IssueDocumentFocusPage({
  issue,
  target,
  motionState = "open",
  mentions,
  imageUploadHandler,
  onClose,
  onDocumentCreated,
}: {
  issue: Issue;
  target: IssueDocumentFocusTarget;
  motionState?: "open" | "closing";
  mentions?: MentionOption[];
  imageUploadHandler?: (file: File) => Promise<string>;
  onClose: () => void;
  onDocumentCreated?: (key: string) => void;
}) {
  const queryClient = useQueryClient();
  const bodyEditorRef = useRef<MarkdownEditorRef | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autosaveDocumentKey, setAutosaveDocumentKey] = useState<string | null>(null);
  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    state: autosaveState,
    markDirty,
    reset,
    runSave,
  } = useAutosaveIndicator();

  const { data: documents } = useQuery({
    queryKey: queryKeys.issues.documents(issue.id),
    queryFn: () => issuesApi.listDocuments(issue.id),
  });

  const sortedDocuments = useMemo(() => {
    return [...(documents ?? [])].sort((a, b) => {
      if (a.key === "plan" && b.key !== "plan") return -1;
      if (a.key !== "plan" && b.key === "plan") return 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [documents]);

  const focusedDocument = target.kind === "existing"
    ? sortedDocuments.find((doc) => doc.key === target.key)
    : null;

  const upsertDocument = useMutation({
    mutationFn: async (nextDraft: DraftState) =>
      issuesApi.upsertDocument(issue.id, nextDraft.key, {
        title: isPlanKey(nextDraft.key) ? null : nextDraft.title.trim() || null,
        format: "markdown",
        body: nextDraft.body,
        baseRevisionId: nextDraft.baseRevisionId,
      }),
  });

  const resetAutosaveState = useCallback(() => {
    setAutosaveDocumentKey(null);
    reset();
  }, [reset]);

  const invalidateIssueDocuments = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
  }, [issue.id, queryClient]);

  useEffect(() => {
    resetAutosaveState();
    setError(null);
    if (target.kind === "new") {
      setDraft({
        key: "",
        title: "",
        body: "",
        baseRevisionId: null,
        isNew: true,
      });
      return;
    }
    if (!focusedDocument) return;
    setDraft({
      key: focusedDocument.key,
      title: focusedDocument.title ?? "",
      body: focusedDocument.body,
      baseRevisionId: focusedDocument.latestRevisionId,
      isNew: false,
    });
  }, [focusedDocument, resetAutosaveState, target.kind]);

  useEffect(() => {
    if (!draft) return;
    if (draft.title.trim()) {
      window.requestAnimationFrame(() => bodyEditorRef.current?.focus());
    }
  }, [draft?.key]);

  useEffect(() => {
    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
    };
  }, []);

  const commitDraft = useCallback(async (currentDraft: DraftState | null, options?: { trackAutosave?: boolean }) => {
    if (!currentDraft || upsertDocument.isPending) return false;
    const normalizedBody = currentDraft.body.trim();
    const normalizedKey = currentDraft.isNew
      ? buildDocumentKey(currentDraft.title, currentDraft.body, sortedDocuments.map((doc) => doc.key))
      : currentDraft.key.trim().toLowerCase();
    const normalizedTitle = inferDocumentTitle(
      currentDraft.title,
      currentDraft.body,
      currentDraft.isNew ? undefined : normalizedKey,
    );

    if (!normalizedBody) {
      if (!currentDraft.isNew) {
        setError("Document body cannot be empty");
      }
      if (options?.trackAutosave) {
        resetAutosaveState();
      }
      return false;
    }

    const existing = sortedDocuments.find((doc) => doc.key === normalizedKey);
    if (
      !currentDraft.isNew &&
      existing &&
      existing.body === currentDraft.body &&
      (existing.title ?? "") === currentDraft.title
    ) {
      if (options?.trackAutosave) {
        resetAutosaveState();
      }
      return true;
    }

    const save = async () => {
      const saved = await upsertDocument.mutateAsync({
        ...currentDraft,
        key: normalizedKey,
        title: isPlanKey(normalizedKey) ? "" : normalizedTitle,
        body: currentDraft.body,
      });
      setError(null);
      setDraft({
        key: saved.key,
        title: saved.title ?? normalizedTitle,
        body: saved.body,
        baseRevisionId: saved.latestRevisionId,
        isNew: false,
      });
      invalidateIssueDocuments();
      if (currentDraft.isNew) {
        onDocumentCreated?.(saved.key);
      }
    };

    try {
      if (options?.trackAutosave) {
        setAutosaveDocumentKey(normalizedKey);
        await runSave(save);
      } else {
        await save();
      }
      return true;
    } catch (err) {
      if (isDocumentConflictError(err)) {
        setError("Document changed remotely. Return to the issue and reopen it to refresh.");
        resetAutosaveState();
        return false;
      }
      setError(err instanceof Error ? err.message : "Failed to save document");
      return false;
    }
  }, [invalidateIssueDocuments, onDocumentCreated, resetAutosaveState, runSave, sortedDocuments, upsertDocument]);

  useEffect(() => {
    if (!draft) return;
    const existing = draft.isNew ? null : sortedDocuments.find((doc) => doc.key === draft.key);
    const hasChanges = draft.isNew
      ? draft.body.trim().length > 0
      : Boolean(existing) && (existing!.body !== draft.body || (existing!.title ?? "") !== draft.title);

    if (!hasChanges) {
      if (autosaveState !== "saved") {
        resetAutosaveState();
      }
      return;
    }

    setError(null);
    setAutosaveDocumentKey(draft.key);
    markDirty();
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    autosaveDebounceRef.current = setTimeout(() => {
      void commitDraft(draft, { trackAutosave: true });
    }, DOCUMENT_AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
    };
  }, [autosaveState, commitDraft, draft, markDirty, resetAutosaveState, sortedDocuments]);

  const title = draft
    ? inferDocumentTitle(draft.title, draft.body, draft.isNew ? undefined : draft.key)
    : target.kind === "existing"
      ? titleCaseWords(target.key)
      : "Untitled document";
  const documentOutline = useMemo(() => extractDocumentOutline(draft?.body ?? ""), [draft?.body]);
  const hasMeaningfulBody = Boolean(draft?.body.trim());
  const hasAutosaveActivity = Boolean(autosaveDocumentKey) || Boolean(draft?.isNew && hasMeaningfulBody);
  const statusLabel = error
    ? "Could not save"
    : autosaveState === "saving" && hasAutosaveActivity
      ? "Saving..."
      : autosaveState === "error" && hasAutosaveActivity
        ? "Could not save"
        : autosaveState === "saved" || (draft && !draft.isNew)
          ? "Saved"
          : "";
  const scrollToOutlineItem = useCallback((item: DocumentOutlineItem) => {
    const headings = Array.from(editorHostRef.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? []);
    const targetHeading = headings[item.headingIndex];
    if (targetHeading instanceof HTMLElement) {
      targetHeading.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    bodyEditorRef.current?.focus();
  }, []);

  return (
    <section
      aria-label="Focused document editor"
      className={cn(
        "min-h-[calc(100dvh-7rem)]",
        motionState === "closing"
          ? "animate-out fade-out-0 slide-out-to-right-2 duration-200"
          : "animate-in fade-in-0 slide-in-from-right-2 duration-200",
      )}
    >
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            onClick={onClose}
            aria-label="Back to issue"
            title="Back to issue"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">{issue.identifier ?? issue.id}</span>
              <span>/</span>
              <span className="truncate">Document</span>
            </div>
            <p className="truncate text-sm font-medium text-foreground">{title}</p>
          </div>
        </div>
        <div className={cn("shrink-0 text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {statusLabel}
        </div>
      </div>

      {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}

      <div className="grid min-h-[calc(100dvh-13rem)] w-full grid-cols-1 gap-6 pt-3 xl:grid-cols-[minmax(0,1fr)_220px]">
        <div className="flex min-h-[calc(100dvh-13rem)] w-full max-w-[980px] min-w-0 flex-col pl-10 pr-4">
          {!draft ? (
            <p className="text-sm text-muted-foreground">Loading document...</p>
          ) : (
            <>
              {!isPlanKey(draft.key) ? (
                <input
                  value={draft.title}
                  onChange={(event) => {
                    setDraft((current) => current ? { ...current, title: event.target.value } : current);
                  }}
                  placeholder="Untitled document"
                  className="w-full bg-transparent text-[28px] font-semibold leading-tight text-foreground outline-none placeholder:text-muted-foreground/45"
                  autoFocus
                />
              ) : (
                <h2 className="text-[28px] font-semibold leading-tight text-foreground">Plan</h2>
              )}
              <div className="mt-4 border-t border-border/60" />
              <div ref={editorHostRef} className="min-h-0 flex-1">
                <MarkdownEditor
                  ref={bodyEditorRef}
                  value={draft.body}
                  onChange={(body) => {
                    setDraft((current) => current ? { ...current, body } : current);
                  }}
                  placeholder="Write the document..."
                  bordered={false}
                  className="mt-4 min-h-0 flex-1 bg-transparent"
                  contentClassName="min-h-[calc(100dvh-20rem)] cursor-text text-[16px] leading-7"
                  mentions={mentions}
                  imageUploadHandler={imageUploadHandler}
                  onSubmit={() => void commitDraft(draft, { trackAutosave: true })}
                />
              </div>
            </>
          )}
        </div>
        <aside aria-label="Document sections" className="hidden min-w-0 xl:block">
          <div className="sticky top-4 border-l border-border/60 py-1 pl-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Sections</div>
            {documentOutline.length > 0 ? (
              <nav className="space-y-0.5">
                {documentOutline.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="block w-full truncate rounded px-2 py-1 text-left text-xs leading-5 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    style={{ paddingLeft: `${8 + Math.max(0, item.level - 1) * 10}px` }}
                    title={item.title}
                    onClick={() => scrollToOutlineItem(item)}
                  >
                    {item.title}
                  </button>
                ))}
              </nav>
            ) : (
              <p className="max-w-[180px] text-xs leading-5 text-muted-foreground/75">
                Add Markdown headings to show sections.
              </p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
