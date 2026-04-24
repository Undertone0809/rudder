import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrganizationResource, Project, ProjectResourceAttachmentRole } from "@rudderhq/shared";
import { organizationsApi } from "@/api/orgs";
import { projectsApi } from "@/api/projects";
import { useOrganization } from "@/context/OrganizationContext";
import { useToast } from "@/context/ToastContext";
import { applyOrganizationPrefix } from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import {
  organizationResourceKindLabel,
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
import { Boxes, FileText, Folder, FolderPlus, Link2, Loader2, Settings2, Trash2 } from "lucide-react";

function createNewResourceDraft() {
  return {
    name: "",
    kind: "directory" as OrganizationResource["kind"],
    locator: "",
    description: "",
    role: "working_set" as const,
    note: "",
  };
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
  const { organizations } = useOrganization();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [attachPopoverOpen, setAttachPopoverOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newResourceDraft, setNewResourceDraft] = useState(createNewResourceDraft());

  const projectOrganization = organizations.find((organization) => organization.id === project.orgId) ?? null;
  const organizationResourcesPath = applyOrganizationPrefix("/resources", projectOrganization?.issuePrefix ?? null);
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
      pushToast({ title: "Project resource attached", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to attach project resource",
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
        title: error instanceof Error ? error.message : "Failed to update project resource",
        tone: "error",
      });
    },
  });

  const removeAttachment = useMutation({
    mutationFn: (attachmentId: string) => projectsApi.removeResourceAttachment(project.id, attachmentId, project.orgId),
    onSuccess: () => {
      invalidateProjectResourceQueries();
      pushToast({ title: "Project resource removed", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to remove project resource",
        tone: "error",
      });
    },
  });

  const createAndAttachResource = useMutation({
    mutationFn: async () => {
      const created = await organizationsApi.createResource(project.orgId, {
        name: newResourceDraft.name.trim(),
        kind: newResourceDraft.kind,
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
      pushToast({ title: "Org resource created and attached", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to create and attach resource",
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
            <div className="text-base font-semibold text-foreground">Resources</div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Choose the repos, docs, URLs, and connector objects agents should actually use on this project. The org
              catalog stays canonical; this tab decides what matters here.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Popover open={attachPopoverOpen} onOpenChange={setAttachPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={availableResources.length === 0 || attachResource.isPending}
                >
                  <Link2 className="mr-1.5 h-3.5 w-3.5" />
                  Attach existing
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[22rem] p-2">
                <div className="px-2 pb-2 pt-1">
                  <div className="text-sm font-medium text-foreground">Attach from org catalog</div>
                  <div className="text-xs text-muted-foreground">
                    Pick an existing shared resource, then add project-specific role and note below.
                  </div>
                </div>
                {availableResources.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground">
                    All org resources are already attached to this project.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {availableResources.map((resource) => {
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
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">{resource.name}</span>
                              <span className="rounded-[calc(var(--radius-sm)-1px)] border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                                {organizationResourceKindLabel(resource.kind)}
                              </span>
                            </div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">{resource.locator}</div>
                            {resource.description ? (
                              <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                {resource.description}
                              </div>
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </PopoverContent>
            </Popover>

            <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
              <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
              Add resource
            </Button>

            <Button asChild variant="outline" size="sm">
              <Link to={organizationResourcesPath}>
                <Settings2 className="mr-1.5 h-3.5 w-3.5" />
                Org catalog
              </Link>
            </Button>
          </div>
        </div>

        <div className="grid gap-3 px-5 py-4 md:grid-cols-3">
          <div className="rounded-[var(--radius-md)] border border-border/70 bg-background/45 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Attached</div>
            <div className="mt-1 text-2xl font-semibold text-foreground">{attachedResources.length}</div>
            <div className="mt-1 text-xs text-muted-foreground">Resources visible to agents on this project.</div>
          </div>
          <div className="rounded-[var(--radius-md)] border border-border/70 bg-background/45 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Working Set</div>
            <div className="mt-1 text-2xl font-semibold text-foreground">{roleCount(attachedResources, "working_set")}</div>
            <div className="mt-1 text-xs text-muted-foreground">The resources agents should actively work inside.</div>
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
            <div className="text-sm font-medium text-foreground">Attached resources</div>
            <div className="text-xs text-muted-foreground">
              Roles and notes here are project-local. They do not change the shared org catalog.
            </div>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          {attachedResources.length === 0 ? (
            <div className="rounded-[var(--radius-md)] border border-dashed border-border/80 bg-background/35 px-4 py-5 text-sm text-muted-foreground">
              No resources attached yet. Start with the repo, spec, tracking system, or any reference agents should
              not miss when working on this project.
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
                              {organizationResourceKindLabel(attachment.resource.kind)}
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
            <DialogTitle>Add resource</DialogTitle>
            <DialogDescription>
              Create a new org resource and attach it to this project in one step. Keep the description concrete so
              agents know when this resource matters.
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
            <label className="space-y-1.5">
              <span className="text-xs text-muted-foreground">Project role</span>
              <select
                value={newResourceDraft.role}
                onChange={(event) => setNewResourceDraft((current) => ({
                  ...current,
                  role: event.target.value as typeof current.role,
                }))}
                className="h-10 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)] px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {projectResourceRoleOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5">
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
