import { organizationsApi } from "@/api/orgs";
import { projectsApi } from "@/api/projects";
import { AddSourcesDialog, isValidLibrarySourcePath } from "@/components/AddSourcesDialog";
import { DraftInput } from "@/components/agent-config-primitives";
import { ResourceLocatorField, suggestResourceNameFromLocator } from "@/components/ResourceLocatorField";
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
import { useDialog } from "@/context/DialogContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  organizationResourceKindLabel,
  organizationResourceSourceTypeLabel,
} from "@/lib/resource-options";
import { cn } from "@/lib/utils";
import type {
  OrganizationResource,
  OrganizationWorkspaceFileEntry,
  Project,
  ProjectResourceAttachmentRole,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, FileText, Folder, FolderPlus, Link2, Loader2, Pencil, Star, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

type ProjectResourceAttachment = Project["resources"][number];
type ProjectResourceEditDraft = {
  name: string;
  locator: string;
  description: string;
  note: string;
};

function createNewResourceDraft() {
  return {
    name: "",
    kind: "directory" as OrganizationResource["kind"],
    sourceType: "external" as OrganizationResource["sourceType"],
    locator: "",
    description: "",
    role: "working_set" as const,
    note: "",
  };
}

function isValidLibraryProjectPath(locator: string, kind: OrganizationResource["kind"] = "file") {
  return isValidLibrarySourcePath(locator, kind === "directory");
}

function libraryNameFromPath(locator: string) {
  const parts = locator.trim().split("/").filter(Boolean);
  return parts.at(-1) ?? locator.trim();
}

function resourceKindIcon(kind: Project["resources"][number]["resource"]["kind"]) {
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

function createResourceEditDraft(attachment: ProjectResourceAttachment): ProjectResourceEditDraft {
  return {
    name: attachment.resource.name,
    locator: attachment.resource.locator,
    description: attachment.resource.description ?? "",
    note: attachment.note ?? "",
  };
}

export function ProjectResourcesPanel({ project }: { project: Project }) {
  const { confirm } = useDialog();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [addSourcesOpen, setAddSourcesOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newResourceDraft, setNewResourceDraft] = useState(createNewResourceDraft());
  const [editingAttachmentId, setEditingAttachmentId] = useState<string | null>(null);
  const [resourceEditDraft, setResourceEditDraft] = useState<ProjectResourceEditDraft | null>(null);

  const attachedResources = useMemo(
    () => [...project.resources].sort((left, right) => left.sortOrder - right.sortOrder),
    [project.resources],
  );

  const { data: organizationResources } = useQuery({
    queryKey: queryKeys.organizations.resources(project.orgId),
    queryFn: () => organizationsApi.listResources(project.orgId),
    enabled: !!project.orgId,
  });

  const libraryResourceByLocator = useMemo(
    () => new Map(
      (organizationResources ?? [])
        .filter((resource) => resource.sourceType === "library")
        .map((resource) => [resource.locator, resource]),
    ),
    [organizationResources],
  );

  const attachedLibraryLocators = useMemo(
    () => new Set(
      project.resources
        .filter((attachment) => attachment.resource.sourceType === "library")
        .map((attachment) => attachment.resource.locator),
    ),
    [project.resources],
  );
  const invalidateProjectResourceQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["projects", "detail"] });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(project.orgId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.resources(project.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.organizations.resources(project.orgId) });
  };

  const attachResource = useMutation({
    mutationFn: (payload: {
      resourceId: string;
      role: ProjectResourceAttachmentRole;
      note?: string | null;
      sortOrder?: number;
      isPrimary?: boolean;
    }) => projectsApi.attachResource(project.id, payload, project.orgId),
    onSuccess: () => {
      invalidateProjectResourceQueries();
      pushToast({ title: "Project source attached", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to attach project source",
        tone: "error",
      });
    },
  });

  const updateAttachment = useMutation({
    mutationFn: (payload: {
      attachmentId: string;
      role?: ProjectResourceAttachmentRole;
      note?: string | null;
      sortOrder?: number;
      isPrimary?: boolean;
    }) =>
      projectsApi.updateResourceAttachment(
        project.id,
        payload.attachmentId,
        { role: payload.role, note: payload.note, sortOrder: payload.sortOrder, isPrimary: payload.isPrimary },
        project.orgId,
      ),
    onSuccess: () => {
      invalidateProjectResourceQueries();
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to update project source",
        tone: "error",
      });
    },
  });

  const updateResourceDetails = useMutation({
    mutationFn: async (payload: {
      attachment: ProjectResourceAttachment;
      draft: ProjectResourceEditDraft;
    }) => {
      const { attachment, draft } = payload;
      const name = draft.name.trim();
      const locator = draft.locator.trim();
      if (!name) throw new Error("Resource name is required.");
      if (!locator) throw new Error("Resource locator is required.");
      const updatedResource = await organizationsApi.updateResource(project.orgId, attachment.resourceId, {
        name,
        locator,
        description: draft.description.trim() || null,
      });
      const updatedAttachment = await projectsApi.updateResourceAttachment(project.id, attachment.id, {
        role: attachment.role,
        note: draft.note.trim() || null,
        sortOrder: attachment.sortOrder,
      }, project.orgId);
      return { updatedResource, updatedAttachment };
    },
    onSuccess: () => {
      setEditingAttachmentId(null);
      setResourceEditDraft(null);
      invalidateProjectResourceQueries();
      pushToast({ title: "Resource updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to update resource",
        tone: "error",
      });
    },
  });

  const removeAttachment = useMutation({
    mutationFn: (attachmentId: string) => projectsApi.removeResourceAttachment(project.id, attachmentId, project.orgId),
    onSuccess: () => {
      invalidateProjectResourceQueries();
      pushToast({ title: "Project source removed", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to remove project source",
        tone: "error",
      });
    },
  });

  const confirmAndRemoveAttachment = async (attachment: ProjectResourceAttachment) => {
    const confirmed = await confirm({
      title: `Remove "${attachment.resource.name}" from this project?`,
      description: "This removes the source from the project. The underlying resource and its files are not deleted.",
      confirmLabel: "Remove source",
      tone: "destructive",
    });
    if (confirmed) removeAttachment.mutate(attachment.id);
  };

  const createAndAttachResource = useMutation({
    mutationFn: async () => {
      const created = await organizationsApi.createResource(project.orgId, {
        name: newResourceDraft.name.trim(),
        kind: newResourceDraft.kind,
        sourceType: newResourceDraft.sourceType,
        locator: newResourceDraft.locator.trim(),
        description: newResourceDraft.description.trim() || undefined,
      });
      return projectsApi.attachResource(project.id, {
        resourceId: created.id,
        role: newResourceDraft.role,
        note: newResourceDraft.note.trim() || undefined,
        sortOrder: project.resources.length,
      }, project.orgId);
    },
    onSuccess: () => {
      invalidateProjectResourceQueries();
      setNewResourceDraft(createNewResourceDraft());
      setCreateDialogOpen(false);
      pushToast({ title: "Resource created and attached", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to create and attach resource",
        tone: "error",
      });
    },
  });

  const createAndAttachLibraryResource = useMutation({
    mutationFn: async (file: OrganizationWorkspaceFileEntry) => {
      const existing = libraryResourceByLocator.get(file.path);
      const resource = existing ?? await organizationsApi.createResource(project.orgId, {
        name: file.displayLabel ?? file.name,
        kind: file.isDirectory ? "directory" : "file",
        sourceType: "library",
        locator: file.path,
        description: undefined,
      });
      return projectsApi.attachResource(project.id, {
        resourceId: resource.id,
        role: file.isDirectory ? "working_set" : "reference",
        sortOrder: project.resources.length,
      }, project.orgId);
    },
    onSuccess: () => {
      invalidateProjectResourceQueries();
      pushToast({ title: "Library resource attached", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to attach Library resource",
        tone: "error",
      });
    },
  });

  const createAndAttachLibraryPath = useMutation({
    mutationFn: async (locator: string) => {
      const normalizedLocator = locator.trim();
      const existing = libraryResourceByLocator.get(normalizedLocator);
      const resource = existing ?? await organizationsApi.createResource(project.orgId, {
        name: libraryNameFromPath(normalizedLocator),
        kind: "file",
        sourceType: "library",
        locator: normalizedLocator,
        description: undefined,
      });
      return projectsApi.attachResource(project.id, {
        resourceId: resource.id,
        role: "reference",
        sortOrder: project.resources.length,
      }, project.orgId);
    },
    onSuccess: () => {
      invalidateProjectResourceQueries();
      pushToast({ title: "Library resource attached", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to attach Library resource",
        tone: "error",
      });
    },
  });

  async function createAndAttachLocalFile(locator: string) {
    const created = await organizationsApi.createResource(project.orgId, {
      name: suggestResourceNameFromLocator(locator),
      kind: "file",
      sourceType: "external",
      locator,
    });
    await attachResource.mutateAsync({ resourceId: created.id, role: "reference", sortOrder: project.resources.length });
  }

  async function createAndAttachUrl(locator: string) {
    const created = await organizationsApi.createResource(project.orgId, {
      name: suggestResourceNameFromLocator(locator),
      kind: "url",
      sourceType: "external",
      locator,
    });
    await attachResource.mutateAsync({ resourceId: created.id, role: "reference", sortOrder: project.resources.length });
  }

  return (
    <div className="space-y-5">
      <section className="rounded-[var(--radius-lg)] border border-border bg-card">
        <div className="flex flex-col gap-4 border-b border-border px-5 py-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1.5">
            <div className="text-base font-semibold text-foreground">Project Sources</div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Choose the sources agents should use for this project. Add a project note only when a source needs local guidance.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => setAddSourcesOpen(true)}
              disabled={attachResource.isPending || createAndAttachLibraryResource.isPending || createAndAttachLibraryPath.isPending}
            >
              <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
              Add sources
            </Button>
          </div>
        </div>

        <div>
          {attachedResources.length === 0 ? (
            <div className="px-5 py-5 text-sm text-muted-foreground">
              No sources attached yet. Add the repo, spec, or URLs agents need for this project.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {attachedResources.map((attachment) => {
                const Icon = resourceKindIcon(attachment.resource.kind);
                const isEditing = editingAttachmentId === attachment.id;
                return (
                  <div key={attachment.id} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="rounded-md border border-border/70 bg-background/85 p-1.5 text-muted-foreground">
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">{attachment.resource.name}</span>
                              {attachment.isPrimary ? (
                                <span className="inline-flex items-center gap-1 rounded-[calc(var(--radius-sm)-1px)] border border-primary/30 bg-primary/8 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                  <Star className="h-2.5 w-2.5 fill-current" />
                                  Primary
                                </span>
                              ) : null}
                              <span className="rounded-[calc(var(--radius-sm)-1px)] border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                                {organizationResourceSourceTypeLabel(attachment.resource.sourceType)} · {organizationResourceKindLabel(attachment.resource.kind)}
                              </span>
                            </div>
                            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                              {attachment.resource.locator}
                            </div>
                          </div>
                        </div>
                        {attachment.resource.description ? (
                          <p className="mt-3 text-sm text-muted-foreground">{attachment.resource.description}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-muted-foreground"
                          aria-label={attachment.isPrimary ? `Clear ${attachment.resource.name} as primary source` : `Make ${attachment.resource.name} primary source`}
                          onClick={() => updateAttachment.mutate({
                            attachmentId: attachment.id,
                            isPrimary: !attachment.isPrimary,
                          })}
                          disabled={updateAttachment.isPending}
                        >
                          <Star className={cn("h-3.5 w-3.5", attachment.isPrimary && "fill-current text-primary")} />
                          {attachment.isPrimary ? "Clear primary" : "Make primary"}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground"
                          aria-label={`Edit ${attachment.resource.name}`}
                          onClick={() => {
                            setEditingAttachmentId(attachment.id);
                            setResourceEditDraft(createResourceEditDraft(attachment));
                          }}
                          disabled={updateResourceDetails.isPending}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground"
                          aria-label={`Remove ${attachment.resource.name}`}
                          onClick={() => void confirmAndRemoveAttachment(attachment)}
                          disabled={removeAttachment.isPending || updateResourceDetails.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {isEditing && resourceEditDraft ? (
                      <div
                        className="mt-4 grid gap-3 rounded-[var(--radius-md)] border border-border/70 bg-background/45 p-3 md:grid-cols-2"
                        data-testid="project-resource-edit-form"
                      >
                        <label className="space-y-1.5">
                          <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Name</span>
                          <Input
                            value={resourceEditDraft.name}
                            onChange={(event) => setResourceEditDraft((current) => current ? ({ ...current, name: event.target.value }) : current)}
                            disabled={updateResourceDetails.isPending}
                          />
                        </label>
                        <label className="space-y-1.5 md:col-span-2">
                          <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Locator</span>
                          <ResourceLocatorField
                            kind={attachment.resource.kind}
                            value={resourceEditDraft.locator}
                            onChange={(locator) => setResourceEditDraft((current) => current ? ({ ...current, locator }) : current)}
                            disabled={updateResourceDetails.isPending}
                          />
                        </label>
                        <label className="space-y-1.5 md:col-span-2">
                          <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Description</span>
                          <Textarea
                            value={resourceEditDraft.description}
                            onChange={(event) => setResourceEditDraft((current) => current ? ({ ...current, description: event.target.value }) : current)}
                            placeholder="What this resource contains and when agents should use it."
                            disabled={updateResourceDetails.isPending}
                          />
                        </label>
                        <label className="space-y-1.5 md:col-span-2">
                          <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Project note</span>
                          <Input
                            value={resourceEditDraft.note}
                            onChange={(event) => setResourceEditDraft((current) => current ? ({ ...current, note: event.target.value }) : current)}
                            placeholder="Optional project-specific guidance for agents"
                            disabled={updateResourceDetails.isPending}
                          />
                        </label>
                        <div className="flex justify-end gap-2 md:col-span-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditingAttachmentId(null);
                              setResourceEditDraft(null);
                            }}
                            disabled={updateResourceDetails.isPending}
                          >
                            <X className="h-3.5 w-3.5" />
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => updateResourceDetails.mutate({ attachment, draft: resourceEditDraft })}
                            disabled={
                              updateResourceDetails.isPending
                              || !resourceEditDraft.name.trim()
                              || !resourceEditDraft.locator.trim()
                            }
                          >
                            {updateResourceDetails.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 space-y-1.5">
                        <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Project note</span>
                        <DraftInput
                          value={attachment.note ?? ""}
                          onCommit={(note) => updateAttachment.mutate({
                            attachmentId: attachment.id,
                            role: attachment.role,
                            note,
                            sortOrder: attachment.sortOrder,
                            isPrimary: attachment.isPrimary,
                          })}
                          immediate
                          className="h-10 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)] px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          placeholder="Optional project-specific guidance for agents"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <AddSourcesDialog
        open={addSourcesOpen}
        orgId={project.orgId}
        resources={organizationResources ?? []}
        excludedResourceIds={new Set(project.resources.map((attachment) => attachment.resourceId))}
        excludedLibraryLocators={attachedLibraryLocators}
        testId="project-add-sources-dialog"
        onOpenChange={setAddSourcesOpen}
        onAddExisting={async (resources) => {
          await Promise.all(resources.map((resource, index) => attachResource.mutateAsync({
            resourceId: resource.id,
            role: resource.kind === "directory" ? "working_set" : "reference",
            sortOrder: project.resources.length + index,
          })));
        }}
        onAddLibraryFile={async (file) => {
          await createAndAttachLibraryResource.mutateAsync(file);
        }}
        onAddLibraryPath={async (locator) => {
          await createAndAttachLibraryPath.mutateAsync(locator);
        }}
        onAddLocalFile={createAndAttachLocalFile}
        onAddUrl={createAndAttachUrl}
      />

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create external resource</DialogTitle>
            <DialogDescription>
              Create a URL, local path, repo path, or connector reference and attach it to this project. Keep the description concrete so
              agents know when this item matters.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-1 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Name</span>
              <Input
                value={newResourceDraft.name}
                onChange={(event) => setNewResourceDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Rudder app repo"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Kind</span>
              <select
                value={newResourceDraft.kind}
                onChange={(event) => setNewResourceDraft((current) => ({
                  ...current,
                  kind: event.target.value as typeof current.kind,
                }))}
                className="h-10 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)] px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="directory">Directory</option>
                <option value="file">File</option>
                <option value="url">URL</option>
                <option value="connector_object">Connector object</option>
              </select>
            </label>
            <label className="space-y-1.5 md:col-span-2">
              <span className="text-xs text-muted-foreground">Locator</span>
              <ResourceLocatorField
                kind={newResourceDraft.kind}
                value={newResourceDraft.locator}
                onChange={(locator) => setNewResourceDraft((current) => ({ ...current, locator }))}
                onPickedPath={(locator) => setNewResourceDraft((current) => ({
                  ...current,
                  locator,
                  name: current.name.trim() ? current.name : suggestResourceNameFromLocator(locator),
                }))}
                disabled={createAndAttachResource.isPending}
              />
            </label>
            <label className="space-y-1.5 md:col-span-2">
              <span className="text-xs text-muted-foreground">Description</span>
              <Textarea
                value={newResourceDraft.description}
                onChange={(event) => setNewResourceDraft((current) => ({ ...current, description: event.target.value }))}
                placeholder="What this resource contains and when agents should use it."
              />
            </label>
            <label className="space-y-1.5 md:col-span-2">
              <span className="text-xs text-muted-foreground">Project note</span>
              <Input
                value={newResourceDraft.note}
                onChange={(event) => setNewResourceDraft((current) => ({ ...current, note: event.target.value }))}
                placeholder="Optional guidance for this project"
              />
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createAndAttachResource.mutate()}
              disabled={
                createAndAttachResource.isPending
                || !newResourceDraft.name.trim()
                || !newResourceDraft.locator.trim()
              }
            >
              {createAndAttachResource.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Create and attach
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
