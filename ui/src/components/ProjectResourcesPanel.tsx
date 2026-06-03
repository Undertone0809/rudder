import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  OrganizationResource,
  OrganizationWorkspaceFileEntry,
  Project,
  ProjectResourceAttachmentRole,
} from "@rudderhq/shared";
import { organizationsApi } from "@/api/orgs";
import { projectsApi } from "@/api/projects";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  organizationResourceKindLabel,
  organizationResourceSourceTypeLabel,
  projectResourceRoleLabel,
  projectResourceRoleOptions,
} from "@/lib/resource-options";
import { DraftInput } from "@/components/agent-config-primitives";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { ResourceLocatorField, suggestResourceNameFromLocator } from "@/components/ResourceLocatorField";
import { Boxes, FileText, Folder, FolderPlus, Link2, Loader2, Trash2 } from "lucide-react";

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

const LIBRARY_PATH_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function isValidLibraryProjectPath(locator: string, kind: OrganizationResource["kind"] = "file") {
  const trimmed = locator.trim();
  if (!trimmed) return false;
  if (LIBRARY_PATH_SCHEME_RE.test(trimmed)) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.startsWith("~")) return false;
  if (trimmed.includes("\\")) return false;
  const parts = trimmed.split("/");
  if (!parts.every((part) => part.length > 0 && part !== "." && part !== "..")) return false;
  if (parts[0] !== "projects") return false;
  return kind === "directory" ? parts.length >= 2 : parts.length >= 3;
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

function roleCount(resources: Project["resources"], role: ProjectResourceAttachmentRole) {
  return resources.filter((resource) => resource.role === role).length;
}

export function ProjectResourcesPanel({ project }: { project: Project }) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [attachPopoverOpen, setAttachPopoverOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newResourceDraft, setNewResourceDraft] = useState(createNewResourceDraft());
  const [librarySearch, setLibrarySearch] = useState("");
  const [resourceSearch, setResourceSearch] = useState("");

  const attachedResources = useMemo(
    () => [...project.resources].sort((left, right) => left.sortOrder - right.sortOrder),
    [project.resources],
  );

  const { data: organizationResources } = useQuery({
    queryKey: queryKeys.organizations.resources(project.orgId),
    queryFn: () => organizationsApi.listResources(project.orgId),
    enabled: !!project.orgId,
  });

  const availableResources = useMemo(
    () => (organizationResources ?? []).filter(
      (resource) => !project.resources.some((attachment) => attachment.resourceId === resource.id),
    ),
    [organizationResources, project.resources],
  );
  const visibleAvailableResources = useMemo(() => {
    const query = resourceSearch.trim().toLowerCase();
    if (!query) return availableResources;
    return availableResources.filter((resource) => [
      resource.name,
      resource.locator,
      resource.description ?? "",
      organizationResourceSourceTypeLabel(resource.sourceType),
      organizationResourceKindLabel(resource.kind),
    ].some((value) => value.toLowerCase().includes(query)));
  }, [availableResources, resourceSearch]);

  const { data: libraryMentionFiles } = useQuery({
    queryKey: queryKeys.organizations.workspaceMentionFiles(project.orgId, librarySearch),
    queryFn: () => organizationsApi.listWorkspaceMentionFiles(project.orgId, {
      query: librarySearch,
      limit: 24,
    }),
    enabled: !!project.orgId && attachPopoverOpen,
  });

  const libraryResourceByLocator = useMemo(
    () => new Map(
      (organizationResources ?? [])
        .filter((resource) => resource.sourceType === "library")
        .map((resource) => [resource.locator, resource]),
    ),
    [organizationResources],
  );

  const availableLibraryFiles = useMemo(() => {
    const attachedLibraryLocators = new Set(
      project.resources
        .filter((attachment) => attachment.resource.sourceType === "library")
        .map((attachment) => attachment.resource.locator),
    );
    const entries = Array.isArray(libraryMentionFiles?.entries) ? libraryMentionFiles.entries : [];
    return entries.filter((entry) =>
      isValidLibraryProjectPath(entry.path, entry.isDirectory ? "directory" : "file")
      && !attachedLibraryLocators.has(entry.path),
    );
  }, [libraryMentionFiles?.entries, project.resources]);
  const normalizedLibrarySearch = librarySearch.trim();
  const attachedLibraryLocators = useMemo(
    () => new Set(
      project.resources
        .filter((attachment) => attachment.resource.sourceType === "library")
        .map((attachment) => attachment.resource.locator),
    ),
    [project.resources],
  );
  const canAddLibrarySearchPath =
    isValidLibraryProjectPath(normalizedLibrarySearch)
    && !attachedLibraryLocators.has(normalizedLibrarySearch)
    && !availableLibraryFiles.some((entry) => entry.path === normalizedLibrarySearch);

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
    }) => projectsApi.attachResource(project.id, payload, project.orgId),
    onSuccess: () => {
      invalidateProjectResourceQueries();
      pushToast({ title: "Project context attached", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to attach project context",
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
    }) =>
      projectsApi.updateResourceAttachment(
        project.id,
        payload.attachmentId,
        { role: payload.role, note: payload.note, sortOrder: payload.sortOrder },
        project.orgId,
      ),
    onSuccess: () => {
      invalidateProjectResourceQueries();
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to update project context",
        tone: "error",
      });
    },
  });

  const removeAttachment = useMutation({
    mutationFn: (attachmentId: string) => projectsApi.removeResourceAttachment(project.id, attachmentId, project.orgId),
    onSuccess: () => {
      invalidateProjectResourceQueries();
      pushToast({ title: "Project context removed", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to remove project context",
        tone: "error",
      });
    },
  });

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
      setAttachPopoverOpen(false);
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
      setAttachPopoverOpen(false);
      setLibrarySearch("");
      pushToast({ title: "Library resource attached", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to attach Library resource",
        tone: "error",
      });
    },
  });

  return (
    <div className="space-y-5">
      <section className="rounded-[var(--radius-lg)] border border-border bg-card">
        <div className="flex flex-col gap-4 border-b border-border px-5 py-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Project Context
            </div>
            <div className="text-base font-semibold text-foreground">Project Context</div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Choose the repos, Library files, URLs, and connector objects agents should actually use on this project. Shared resources
              stay canonical; this tab decides what matters here.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Popover
              open={attachPopoverOpen}
              onOpenChange={(open) => {
                setAttachPopoverOpen(open);
                if (!open) {
                  setLibrarySearch("");
                  setResourceSearch("");
                }
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  disabled={attachResource.isPending || createAndAttachLibraryResource.isPending || createAndAttachLibraryPath.isPending}
                >
                  <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
                  Add resources
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="max-h-[460px] w-[22rem] overflow-y-auto p-2">
                <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Add from Library
                </div>
                <div className="px-2 pb-2">
                  <Input
                    value={librarySearch}
                    onChange={(event) => setLibrarySearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && canAddLibrarySearchPath) {
                        event.preventDefault();
                        createAndAttachLibraryPath.mutate(normalizedLibrarySearch);
                      }
                    }}
                    className="h-8 text-xs"
                    placeholder="Search Library or paste relative path"
                  />
                </div>
                {availableLibraryFiles.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground">
                    {librarySearch.trim() ? "No matching Library files." : "No Library files available."}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {availableLibraryFiles.map((file) => {
                      const Icon = file.isDirectory ? Folder : FileText;
                      return (
                        <button
                          key={file.path}
                          type="button"
                          className="flex w-full items-start gap-3 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-2 py-2 text-left transition-colors hover:border-border hover:bg-accent/35"
                          onClick={() => createAndAttachLibraryResource.mutate(file)}
                        >
                          <div className="mt-0.5 rounded-md border border-border/70 bg-background/80 p-1.5 text-muted-foreground">
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">{file.displayLabel ?? file.name}</div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">{file.path}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {canAddLibrarySearchPath ? (
                  <button
                    type="button"
                    className="mt-1 flex w-full items-start gap-3 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-2 py-2 text-left transition-colors hover:border-border hover:bg-accent/35"
                    onClick={() => createAndAttachLibraryPath.mutate(normalizedLibrarySearch)}
                    disabled={createAndAttachLibraryPath.isPending}
                  >
                    <div className="mt-0.5 rounded-md border border-border/70 bg-background/80 p-1.5 text-muted-foreground">
                      <FileText className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">Use this Library path</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {normalizedLibrarySearch}
                      </div>
                    </div>
                  </button>
                ) : null}

                <div className="my-2 h-px bg-border" />
                <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Existing resources
                </div>
                <div className="px-2 pb-2">
                  <Input
                    value={resourceSearch}
                    onChange={(event) => setResourceSearch(event.target.value)}
                    className="h-8 text-xs"
                    placeholder="Search existing resources"
                  />
                </div>
                {visibleAvailableResources.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground">
                    {resourceSearch.trim() ? "No matching resources." : "All resources are already attached to this project."}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {visibleAvailableResources.map((resource) => {
                      const Icon = resourceKindIcon(resource.kind);
                      return (
                        <button
                          key={resource.id}
                          type="button"
                          className="flex w-full items-start gap-3 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-2 py-2 text-left transition-colors hover:border-border hover:bg-accent/35"
                          onClick={() => {
                            attachResource.mutate({
                              resourceId: resource.id,
                              role: "reference",
                              sortOrder: project.resources.length,
                            });
                            setAttachPopoverOpen(false);
                          }}
                        >
                          <div className="mt-0.5 rounded-md border border-border/70 bg-background/80 p-1.5 text-muted-foreground">
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">{resource.name}</div>
                            <div className="truncate text-[11px] text-muted-foreground">
                              {organizationResourceSourceTypeLabel(resource.sourceType)} · {organizationResourceKindLabel(resource.kind)} · {resource.locator}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="my-2 h-px bg-border" />
                <button
                  type="button"
                  className="flex w-full items-start gap-3 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-2 py-2 text-left transition-colors hover:border-border hover:bg-accent/35"
                  onClick={() => {
                    setCreateDialogOpen(true);
                    setAttachPopoverOpen(false);
                  }}
                >
                  <div className="mt-0.5 rounded-md border border-border/70 bg-background/80 p-1.5 text-muted-foreground">
                    <Link2 className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-foreground">Create external resource</div>
                    <div className="text-xs text-muted-foreground">Add a URL, local path, repo path, or connector reference.</div>
                  </div>
                </button>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="grid gap-3 px-5 py-4 md:grid-cols-3">
          <div className="rounded-[var(--radius-md)] border border-border/70 bg-background/45 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Attached</div>
            <div className="mt-1 text-2xl font-semibold text-foreground">{attachedResources.length}</div>
            <div className="mt-1 text-xs text-muted-foreground">Shared context visible from this project.</div>
          </div>
          <div className="rounded-[var(--radius-md)] border border-border/70 bg-background/45 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Working Set</div>
            <div className="mt-1 text-2xl font-semibold text-foreground">{roleCount(attachedResources, "working_set")}</div>
            <div className="mt-1 text-xs text-muted-foreground">The context agents should actively work inside.</div>
          </div>
          <div className="rounded-[var(--radius-md)] border border-border/70 bg-background/45 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Reference</div>
            <div className="mt-1 text-2xl font-semibold text-foreground">{roleCount(attachedResources, "reference")}</div>
            <div className="mt-1 text-xs text-muted-foreground">Background material that frames decisions and output.</div>
          </div>
        </div>
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <div className="text-sm font-medium text-foreground">Attached context</div>
            <div className="text-xs text-muted-foreground">
              Roles and notes here are project-local. They do not change the shared resource.
            </div>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          {attachedResources.length === 0 ? (
            <div className="rounded-[var(--radius-md)] border border-dashed border-border/80 bg-background/35 px-4 py-5 text-sm text-muted-foreground">
              No context attached yet. Start with the repo, spec, tracking system, or any shared reference agents
              should not miss when working on this project.
            </div>
          ) : (
            attachedResources.map((attachment) => {
              const Icon = resourceKindIcon(attachment.resource.kind);
              return (
                <div
                  key={attachment.id}
                  className="rounded-[var(--radius-md)] border border-border/75 bg-[color:color-mix(in_oklab,var(--surface-elevated)_92%,transparent)] px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="rounded-md border border-border/70 bg-background/85 p-1.5 text-muted-foreground">
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">{attachment.resource.name}</span>
                            <span className="rounded-[calc(var(--radius-sm)-1px)] border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                              {organizationResourceSourceTypeLabel(attachment.resource.sourceType)} · {organizationResourceKindLabel(attachment.resource.kind)}
                            </span>
                            <span className="rounded-[calc(var(--radius-sm)-1px)] border border-emerald-300/50 bg-emerald-500/8 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-emerald-700 dark:text-emerald-300">
                              {projectResourceRoleLabel(attachment.role)}
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground"
                      onClick={() => removeAttachment.mutate(attachment.id)}
                      disabled={removeAttachment.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-[180px_minmax(0,1fr)]">
                    <label className="space-y-1.5">
                      <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Project role</span>
                      <select
                        value={attachment.role}
                        onChange={(event) => updateAttachment.mutate({
                          attachmentId: attachment.id,
                          role: event.target.value as typeof attachment.role,
                          note: attachment.note,
                          sortOrder: attachment.sortOrder,
                        })}
                        className="h-10 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)] px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {projectResourceRoleOptions.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>

                    <div className="space-y-1.5">
                      <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Project note</span>
                      <DraftInput
                        value={attachment.note ?? ""}
                        onCommit={(note) => updateAttachment.mutate({
                          attachmentId: attachment.id,
                          role: attachment.role,
                          note,
                          sortOrder: attachment.sortOrder,
                        })}
                        immediate
                        className="h-10 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)] px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        placeholder="Optional project-specific guidance for agents"
                      />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

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
