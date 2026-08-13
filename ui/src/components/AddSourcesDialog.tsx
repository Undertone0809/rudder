import { instanceSettingsApi } from "@/api/instanceSettings";
import { organizationsApi } from "@/api/orgs";
import { useI18n } from "@/context/I18nContext";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { libraryCopy } from "@/lib/library-copy";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { OrganizationResource, OrganizationWorkspaceFileEntry } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileText, Folder, FolderOpen, Globe2, LibraryBig, Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

type AddSourcesView = "choose" | "library" | "local" | "url";

const controlClass =
  "w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)] px-2.5 py-1.5 text-sm shadow-none outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const pathScheme = /^[a-z][a-z0-9+.-]*:/i;

export function isValidLibrarySourcePath(locator: string, directory = false) {
  const trimmed = locator.trim();
  if (!trimmed || pathScheme.test(trimmed) || /^[\\/~]/.test(trimmed) || trimmed.includes("\\")) return false;
  const parts = trimmed.split("/");
  if (!parts.every((part) => part && part !== "." && part !== "..") || parts[0] !== "projects") return false;
  return directory ? parts.length >= 2 : parts.length >= 3;
}

export function isHttpSourceUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

type Props = {
  open: boolean;
  orgId: string;
  resources: OrganizationResource[];
  excludedResourceIds?: Iterable<string>;
  excludedLibraryLocators?: Iterable<string>;
  testId?: string;
  onOpenChange: (open: boolean) => void;
  onAddExisting: (resources: OrganizationResource[]) => void | Promise<void>;
  onAddLibraryFile: (file: OrganizationWorkspaceFileEntry) => void | Promise<void>;
  onAddLibraryPath: (locator: string) => void | Promise<void>;
  onAddLocalFile: (locator: string) => void | Promise<void>;
  onAddUrl: (locator: string) => void | Promise<void>;
};

export function AddSourcesDialog({
  open,
  orgId,
  resources,
  excludedResourceIds = [],
  excludedLibraryLocators = [],
  testId = "add-sources-dialog",
  onOpenChange,
  onAddExisting,
  onAddLibraryFile,
  onAddLibraryPath,
  onAddLocalFile,
  onAddUrl,
}: Props) {
  const { locale } = useI18n();
  const [view, setView] = useState<AddSourcesView>("choose");
  const [librarySearch, setLibrarySearch] = useState("");
  const [selectedLocalIds, setSelectedLocalIds] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const libraryScrollRef = useScrollbarActivityRef();
  const localScrollRef = useScrollbarActivityRef();
  const excludedIds = useMemo(() => new Set(excludedResourceIds), [excludedResourceIds]);
  const excludedLocators = useMemo(() => new Set(excludedLibraryLocators), [excludedLibraryLocators]);

  const { data: libraryFiles } = useQuery({
    queryKey: queryKeys.organizations.workspaceMentionFiles(orgId, librarySearch),
    queryFn: () => organizationsApi.listWorkspaceMentionFiles(orgId, { query: librarySearch, limit: 24 }),
    enabled: open && view === "library",
  });
  const recentLocal = resources
    .filter((resource) => !excludedIds.has(resource.id) && resource.sourceType === "external" && ["file", "directory"].includes(resource.kind))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const availableLibrary = (libraryFiles?.entries ?? []).filter((file) =>
    isValidLibrarySourcePath(file.path, file.isDirectory) && !excludedLocators.has(file.path));
  const normalizedLibraryPath = librarySearch.trim();
  const canAddLibraryPath = isValidLibrarySourcePath(normalizedLibraryPath)
    && !excludedLocators.has(normalizedLibraryPath)
    && !availableLibrary.some((file) => file.path === normalizedLibraryPath);

  function reset(nextOpen = false) {
    if (!nextOpen) {
      setView("choose");
      setLibrarySearch("");
      setSelectedLocalIds([]);
      setUrl("");
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  async function finish(action: () => void | Promise<void>) {
    setError(null);
    try {
      await action();
      reset(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add this source. Try again.");
    }
  }

  async function chooseFile() {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const result = await instanceSettingsApi.pickPath({ selectionType: "file" });
      if (!result.cancelled && result.path) {
        await finish(() => onAddLocalFile(result.path!));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the file picker. Try again from the Rudder Desktop app.");
    } finally {
      setPicking(false);
    }
  }

  const title = view === "library" ? "Add from library" : view === "local" ? "Select from local" : view === "url" ? "Add from URL" : "Add sources";

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent showCloseButton={false} className="isolate flex max-h-[min(680px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 before:absolute before:inset-0 before:-z-10 before:bg-card sm:max-w-lg" data-testid={testId}>
        <DialogDescription className="sr-only">Choose one source type, then provide only the details for that source.</DialogDescription>
        <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {view !== "choose" ? <Button type="button" variant="ghost" size="icon-xs" aria-label="Back to source types" onClick={() => { setView("choose"); setError(null); }}><ArrowLeft className="h-3.5 w-3.5" /></Button> : null}
            <DialogTitle className="truncate text-base font-medium">{title}</DialogTitle>
          </div>
          <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Close add sources" onClick={() => reset(false)}><X className="h-3.5 w-3.5" /></Button>
        </div>

        {view === "choose" ? <div className="grid gap-2 p-4">{[
          { view: "library" as const, label: "Add from library", detail: "Reuse files already in this organization", icon: LibraryBig },
          { view: "local" as const, label: "Select from local", detail: "Reuse recent sources or choose a file", icon: FolderOpen },
          { view: "url" as const, label: "Add from URL", detail: "Link a webpage or remote reference", icon: Globe2 },
        ].map((option) => <button key={option.view} type="button" className="group flex w-full items-center gap-3 rounded-[var(--radius-sm)] border border-border/80 px-3 py-3 text-left transition-colors hover:border-border-strong hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setView(option.view)}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] border border-border/70 bg-muted/40 text-muted-foreground group-hover:text-foreground"><option.icon className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{option.label}</span><span className="mt-0.5 block text-xs text-muted-foreground">{option.detail}</span></span><span className="text-muted-foreground">&rsaquo;</span>
        </button>)}</div> : null}

        {view === "library" ? <><div className="shrink-0 border-b border-border px-4 py-3"><input value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && canAddLibraryPath) { event.preventDefault(); void finish(() => onAddLibraryPath(normalizedLibraryPath)); } }} className={cn(controlClass, "h-8")} placeholder={libraryCopy("searchLibraryPlaceholder", locale)} autoFocus /></div>
          <div ref={libraryScrollRef} data-testid="new-project-library-sources-scroll" className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {availableLibrary.length === 0 && !canAddLibraryPath ? <div className="px-2 py-8 text-center text-sm text-muted-foreground">{librarySearch.trim() ? libraryCopy("noMatchingLibraryFiles", locale) : libraryCopy("noLibraryFiles", locale)}</div> : availableLibrary.map((file) => { const Icon = file.isDirectory ? Folder : FileText; return <button key={file.path} type="button" className="flex w-full items-start gap-3 rounded-[calc(var(--radius-sm)-1px)] px-2 py-2.5 text-left hover:bg-accent/50" onClick={() => void finish(() => onAddLibraryFile(file))}><Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{file.displayLabel ?? file.name}</span><span className="block truncate font-mono text-[11px] text-muted-foreground">{file.path}</span></span></button>; })}
            {canAddLibraryPath ? <button type="button" className="flex w-full items-start gap-3 rounded-[calc(var(--radius-sm)-1px)] px-2 py-2.5 text-left hover:bg-accent/50" onClick={() => void finish(() => onAddLibraryPath(normalizedLibraryPath))}><FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{libraryCopy("useThisLibraryPath", locale)}</span><span className="block truncate font-mono text-[11px] text-muted-foreground">{normalizedLibraryPath}</span></span></button> : null}
          </div></> : null}

        {view === "local" ? <><div className="flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-sm font-medium">Recent sources</div><div className="mt-0.5 text-xs text-muted-foreground">Select one or more to add again.</div></div><Button type="button" variant="outline" size="sm" className="shrink-0" disabled={picking} onClick={() => void chooseFile()}>{picking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}Choose file</Button></div>
          <div ref={localScrollRef} data-testid="new-project-local-sources-scroll" className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain">{recentLocal.length === 0 ? <div className="px-4 py-10 text-center text-sm text-muted-foreground">No recent local sources yet.</div> : recentLocal.map((resource) => { const Icon = resource.kind === "directory" ? Folder : FileText; return <label key={resource.id} className="flex cursor-pointer items-center gap-3 border-b border-border/70 px-4 py-3 transition-colors last:border-b-0 hover:bg-accent/30"><input type="checkbox" checked={selectedLocalIds.includes(resource.id)} onChange={(event) => setSelectedLocalIds((current) => event.target.checked ? [...current, resource.id] : current.filter((id) => id !== resource.id))} className="h-4 w-4 shrink-0 accent-primary" /><Icon className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{resource.name}</span><span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{resource.locator}</span></span></label>; })}</div>
          {error ? <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-destructive">{error}</p> : null}<div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3"><span className="text-xs text-muted-foreground">{selectedLocalIds.length === 0 ? "No sources selected" : `${selectedLocalIds.length} source${selectedLocalIds.length === 1 ? "" : "s"} selected`}</span><Button type="button" size="sm" disabled={selectedLocalIds.length === 0} onClick={() => void finish(() => onAddExisting(recentLocal.filter((resource) => selectedLocalIds.includes(resource.id))))}>Add sources</Button></div></> : null}

        {view === "url" ? <><div className="grid gap-2 p-4"><label htmlFor={`${testId}-url`} className="text-xs text-muted-foreground">URL</label><input id={`${testId}-url`} type="url" value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && isHttpSourceUrl(url)) { event.preventDefault(); void finish(() => onAddUrl(url.trim())); } }} className={cn(controlClass, "h-9")} placeholder="https://example.com/reference" autoFocus />{url.trim() && !isHttpSourceUrl(url) ? <p className="text-xs text-destructive">Enter a valid http:// or https:// URL.</p> : null}</div><div className="flex shrink-0 justify-end border-t border-border px-4 py-3"><Button type="button" size="sm" disabled={!isHttpSourceUrl(url)} onClick={() => void finish(() => onAddUrl(url.trim()))}>Add source</Button></div></> : null}
      </DialogContent>
    </Dialog>
  );
}
