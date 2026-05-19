import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { LibraryDocument, LibraryDocumentSummary, OrganizationResource } from "@rudderhq/shared";
import { organizationsApi } from "../api/orgs";
import { useToast } from "../context/ToastContext";
import { useViewedOrganization } from "../hooks/useViewedOrganization";
import { queryKeys } from "../lib/queryKeys";
import { organizationResourceKindLabel, organizationResourceKindOptions } from "../lib/resource-options";
import { ResourceLocatorField, suggestResourceNameFromLocator } from "../components/ResourceLocatorField";
import { OrganizationWorkspaceBrowser } from "./OrganizationWorkspaces";
import {
  Boxes,
  FileText,
  Folder,
  History,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";

function createOrganizationResourceDraft() {
  return {
    name: "",
    kind: "directory" as OrganizationResource["kind"],
    locator: "",
    description: "",
  };
}

function resourceKindIcon(kind: OrganizationResource["kind"]) {
  switch (kind) {
    case "directory":
      return Folder;
    case "file":
      return FileText;
    case "connector_object":
      return Boxes;
    case "url":
    default:
      return Link2;
  }
}

function libraryDocumentTitle(doc: Pick<LibraryDocumentSummary, "id" | "title" | "issueLinks">) {
  if (doc.title?.trim()) return doc.title.trim();
  const issueLink = doc.issueLinks?.[0] ?? null;
  if (issueLink) return `${issueLink.issueIdentifier ?? issueLink.issueId.slice(0, 8)} / ${issueLink.key}`;
  return `Document ${doc.id.slice(0, 8)}`;
}

export function OrganizationResources() {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { viewedOrganizationId } = useViewedOrganization();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedDocumentId = searchParams.get("doc");
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [editingResourceId, setEditingResourceId] = useState<string | null>(null);
  const [resourceDraft, setResourceDraft] = useState(createOrganizationResourceDraft());
  const [documentDraft, setDocumentDraft] = useState({ title: "", body: "" });

  const resourcesQuery = useQuery({
    queryKey: queryKeys.organizations.resources(viewedOrganizationId ?? "__none__"),
    queryFn: () => organizationsApi.listResources(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
  });

  const libraryDocumentsQuery = useQuery({
    queryKey: queryKeys.organizations.libraryDocuments(viewedOrganizationId ?? "__none__"),
    queryFn: () => organizationsApi.listLibraryDocuments(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
  });

  const selectedDocumentQuery = useQuery({
    queryKey: queryKeys.organizations.libraryDocument(viewedOrganizationId ?? "__none__", selectedDocumentId ?? "__none__"),
    queryFn: () => organizationsApi.getLibraryDocument(viewedOrganizationId!, selectedDocumentId!),
    enabled: !!viewedOrganizationId && !!selectedDocumentId,
  });

  const revisionsQuery = useQuery({
    queryKey: queryKeys.organizations.libraryDocumentRevisions(viewedOrganizationId ?? "__none__", selectedDocumentId ?? "__none__"),
    queryFn: () => organizationsApi.listLibraryDocumentRevisions(viewedOrganizationId!, selectedDocumentId!),
    enabled: !!viewedOrganizationId && !!selectedDocumentId,
  });

  useEffect(() => {
    const doc = selectedDocumentQuery.data;
    if (!doc) {
      setDocumentDraft({ title: "", body: "" });
      return;
    }
    setDocumentDraft({
      title: doc.title ?? libraryDocumentTitle(doc),
      body: doc.body,
    });
  }, [selectedDocumentQuery.data]);

  const createResource = useMutation({
    mutationFn: () => organizationsApi.createResource(viewedOrganizationId!, {
      name: resourceDraft.name.trim(),
      kind: resourceDraft.kind,
      locator: resourceDraft.locator.trim(),
      description: resourceDraft.description.trim() || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.resources(viewedOrganizationId ?? "__none__") });
      setResourceDialogOpen(false);
      setEditingResourceId(null);
      setResourceDraft(createOrganizationResourceDraft());
      pushToast({ title: "Library item created", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to create Library item",
        tone: "error",
      });
    },
  });

  const updateResource = useMutation({
    mutationFn: (resourceId: string) =>
      organizationsApi.updateResource(viewedOrganizationId!, resourceId, {
        name: resourceDraft.name.trim(),
        kind: resourceDraft.kind,
        locator: resourceDraft.locator.trim(),
        description: resourceDraft.description.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.resources(viewedOrganizationId ?? "__none__") });
      setResourceDialogOpen(false);
      setEditingResourceId(null);
      setResourceDraft(createOrganizationResourceDraft());
      pushToast({ title: "Library item updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to update Library item",
        tone: "error",
      });
    },
  });

  const removeResource = useMutation({
    mutationFn: (resourceId: string) => organizationsApi.removeResource(viewedOrganizationId!, resourceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.resources(viewedOrganizationId ?? "__none__") });
      pushToast({ title: "Library item removed", tone: "success" });
    },
  });

  const createDocument = useMutation({
    mutationFn: () => organizationsApi.createLibraryDocument(viewedOrganizationId!, {
      title: "Untitled document",
      format: "markdown",
      body: "",
    }),
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.libraryDocuments(viewedOrganizationId ?? "__none__") });
      const next = new URLSearchParams(searchParams);
      next.set("doc", doc.id);
      setSearchParams(next, { replace: true });
      pushToast({ title: "Library doc created", tone: "success" });
    },
  });

  const saveDocument = useMutation({
    mutationFn: (doc: LibraryDocument) => organizationsApi.updateLibraryDocument(viewedOrganizationId!, doc.id, {
      title: documentDraft.title.trim() || null,
      format: "markdown",
      body: documentDraft.body,
      baseRevisionId: doc.latestRevisionId,
    }),
    onSuccess: (doc) => {
      queryClient.setQueryData(queryKeys.organizations.libraryDocument(viewedOrganizationId ?? "__none__", doc.id), doc);
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.libraryDocuments(viewedOrganizationId ?? "__none__") });
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.libraryDocumentRevisions(viewedOrganizationId ?? "__none__", doc.id) });
      pushToast({ title: "Library doc saved", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to save Library doc",
        tone: "error",
      });
    },
  });

  const restoreRevision = useMutation({
    mutationFn: (revisionId: string) =>
      organizationsApi.restoreLibraryDocumentRevision(viewedOrganizationId!, selectedDocumentId!, revisionId),
    onSuccess: (doc) => {
      queryClient.setQueryData(queryKeys.organizations.libraryDocument(viewedOrganizationId ?? "__none__", doc.id), doc);
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.libraryDocuments(viewedOrganizationId ?? "__none__") });
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.libraryDocumentRevisions(viewedOrganizationId ?? "__none__", doc.id) });
      pushToast({ title: "Library doc restored", tone: "success" });
    },
  });

  const openCreateResourceDialog = () => {
    setEditingResourceId(null);
    setResourceDraft(createOrganizationResourceDraft());
    setResourceDialogOpen(true);
  };

  const openEditResourceDialog = (resource: OrganizationResource) => {
    setEditingResourceId(resource.id);
    setResourceDraft({
      name: resource.name,
      kind: resource.kind,
      locator: resource.locator,
      description: resource.description ?? "",
    });
    setResourceDialogOpen(true);
  };

  const closeResourceDialog = (open: boolean) => {
    setResourceDialogOpen(open);
    if (!open) {
      setEditingResourceId(null);
      setResourceDraft(createOrganizationResourceDraft());
    }
  };

  const resourceItems = resourcesQuery.data ?? [];
  const libraryDocuments = libraryDocumentsQuery.data ?? [];
  const selectedDocument = selectedDocumentQuery.data ?? null;
  const documentHasChanges = Boolean(
    selectedDocument
    && (documentDraft.body !== selectedDocument.body || documentDraft.title !== (selectedDocument.title ?? libraryDocumentTitle(selectedDocument))),
  );
  const resourceDialogPending = createResource.isPending || updateResource.isPending;
  const resourceDialogTitle = editingResourceId ? "Edit Library item" : "Add Library item";
  const resourceDialogDescription = editingResourceId
    ? "Update this reusable Library binding. Projects that reference it will see the new metadata automatically."
    : "Add a reusable repo, file, URL, folder, or connector object that projects can attach directly.";

  const rightPanel = useMemo(() => (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium text-foreground">Library</div>
            <div className="text-xs text-muted-foreground">Docs, resources, and live issue links</div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => createDocument.mutate()}
              disabled={createDocument.isPending}
              aria-label="New Library doc"
              title="New Library doc"
            >
              {createDocument.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={openCreateResourceDialog}
              aria-label="Add Library resource"
              title="Add Library resource"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-auto px-3 py-3">
        {selectedDocumentId ? (
          <div className="space-y-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("doc");
                setSearchParams(next, { replace: true });
              }}
            >
              Back to docs
            </Button>
            {selectedDocumentQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading Library doc...</p>
            ) : selectedDocumentQuery.error ? (
              <p className="text-sm text-destructive">{selectedDocumentQuery.error.message}</p>
            ) : selectedDocument ? (
              <>
                <Input
                  value={documentDraft.title}
                  onChange={(event) => setDocumentDraft((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Untitled document"
                />
                <Textarea
                  value={documentDraft.body}
                  onChange={(event) => setDocumentDraft((current) => ({ ...current, body: event.target.value }))}
                  placeholder="Write Markdown..."
                  className="min-h-[260px] font-mono text-xs leading-5"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => saveDocument.mutate(selectedDocument)}
                  disabled={!documentHasChanges || saveDocument.isPending}
                >
                  {saveDocument.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
                  Save doc
                </Button>
                <div className="space-y-2 border-t border-border pt-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <History className="h-3.5 w-3.5" />
                    History
                  </div>
                  {(revisionsQuery.data ?? []).map((revision) => (
                    <div key={revision.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
                      <span className="text-muted-foreground">Revision {revision.revisionNumber}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => restoreRevision.mutate(revision.id)}
                        disabled={restoreRevision.isPending || revision.id === selectedDocument.latestRevisionId}
                        aria-label={`Restore revision ${revision.revisionNumber}`}
                        title={`Restore revision ${revision.revisionNumber}`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Docs</div>
              {libraryDocuments.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                  No Library docs yet. Create one here, or mention migrated issue docs as live links.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {libraryDocuments.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      className="flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent/50"
                      onClick={() => {
                        const next = new URLSearchParams(searchParams);
                        next.set("doc", doc.id);
                        setSearchParams(next, { replace: true });
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{libraryDocumentTitle(doc)}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {doc.issueLinks?.[0] ? "migrated issue doc" : "Library doc"} / r{doc.latestRevisionNumber}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-xs font-medium text-muted-foreground">Resource bindings</div>
              {resourceItems.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                  No resource bindings yet.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {resourceItems.map((resource) => {
                    const Icon = resourceKindIcon(resource.kind);
                    return (
                      <div key={resource.id} className="rounded-md border border-border px-2 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{resource.name}</div>
                              <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                                {organizationResourceKindLabel(resource.kind)}
                              </div>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => openEditResourceDialog(resource)}
                              aria-label={`Edit ${resource.name}`}
                              title={`Edit ${resource.name}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => removeResource.mutate(resource.id)}
                              disabled={removeResource.isPending}
                              aria-label={`Remove ${resource.name}`}
                              title={`Remove ${resource.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                        <div className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{resource.locator}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  ), [
    createDocument,
    documentDraft.body,
    documentDraft.title,
    documentHasChanges,
    libraryDocuments,
    removeResource,
    resourceItems,
    restoreRevision,
    revisionsQuery.data,
    saveDocument,
    searchParams,
    selectedDocument,
    selectedDocumentId,
    selectedDocumentQuery.error,
    selectedDocumentQuery.isLoading,
    setSearchParams,
  ]);

  return (
    <>
      <OrganizationWorkspaceBrowser
        breadcrumbLabel="Library"
        emptyMessage="Select an organization to browse its Library."
        filesTitle="File tree"
        editorTitle="File editor"
        noSelectionMessage="Choose a Markdown, CSV, JSON, HTML, skill, or workspace file from the Library tree. Humans and agents share this file-native space."
        rightPanel={rightPanel}
      />

      <Dialog open={resourceDialogOpen} onOpenChange={closeResourceDialog}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{resourceDialogTitle}</DialogTitle>
            <DialogDescription>{resourceDialogDescription}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-1 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Name</span>
              <Input
                value={resourceDraft.name}
                onChange={(event) => setResourceDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Rudder repo"
              />
            </label>

            <label className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Kind</span>
              <select
                value={resourceDraft.kind}
                onChange={(event) => setResourceDraft((current) => ({
                  ...current,
                  kind: event.target.value as typeof current.kind,
                }))}
                className="h-10 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)] px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {organizationResourceKindOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1.5 md:col-span-2">
              <span className="text-xs text-muted-foreground">Locator</span>
              <ResourceLocatorField
                kind={resourceDraft.kind}
                value={resourceDraft.locator}
                onChange={(locator) => setResourceDraft((current) => ({ ...current, locator }))}
                onPickedPath={(locator) => setResourceDraft((current) => ({
                  ...current,
                  locator,
                  name: current.name.trim() ? current.name : suggestResourceNameFromLocator(locator),
                }))}
                disabled={resourceDialogPending}
              />
            </label>

            <label className="space-y-1.5 md:col-span-2">
              <span className="text-xs text-muted-foreground">Description</span>
              <Textarea
                value={resourceDraft.description}
                onChange={(event) => setResourceDraft((current) => ({ ...current, description: event.target.value }))}
                placeholder="What this Library item contains and when agents should use it."
              />
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => closeResourceDialog(false)} disabled={resourceDialogPending}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (editingResourceId) {
                  updateResource.mutate(editingResourceId);
                  return;
                }
                createResource.mutate();
              }}
              disabled={resourceDialogPending || resourceDraft.name.trim().length === 0 || resourceDraft.locator.trim().length === 0}
            >
              {resourceDialogPending ? "Saving..." : editingResourceId ? "Save changes" : "Create Library item"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
