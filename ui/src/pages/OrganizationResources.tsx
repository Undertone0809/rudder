import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
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
import type { OrganizationResource } from "@rudder/shared";
import { organizationsApi } from "../api/orgs";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { useViewedOrganization } from "../hooks/useViewedOrganization";
import { applyOrganizationPrefix } from "../lib/organization-routes";
import { queryKeys } from "../lib/queryKeys";
import { organizationResourceKindLabel, organizationResourceKindOptions } from "../lib/resource-options";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ResourceLocatorField, suggestResourceNameFromLocator } from "../components/ResourceLocatorField";
import {
  Boxes,
  FileText,
  Folder,
  HardDrive,
  Layers3,
  Link2,
  Pencil,
  Plus,
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

export function OrganizationResources() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { viewedOrganization, viewedOrganizationId } = useViewedOrganization();
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [editingResourceId, setEditingResourceId] = useState<string | null>(null);
  const [resourceDraft, setResourceDraft] = useState(createOrganizationResourceDraft());

  useEffect(() => {
    setBreadcrumbs([{ label: "Resources" }]);
  }, [setBreadcrumbs]);

  const resourcesQuery = useQuery({
    queryKey: queryKeys.organizations.resources(viewedOrganizationId ?? "__none__"),
    queryFn: () => organizationsApi.listResources(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
  });

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
      pushToast({ title: "Org resource created", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to create org resource",
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
      pushToast({ title: "Org resource updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to update org resource",
        tone: "error",
      });
    },
  });

  const removeResource = useMutation({
    mutationFn: (resourceId: string) => organizationsApi.removeResource(viewedOrganizationId!, resourceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.resources(viewedOrganizationId ?? "__none__") });
      pushToast({ title: "Org resource removed", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to remove org resource",
        tone: "error",
      });
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

  if (!viewedOrganizationId || !viewedOrganization) {
    return <EmptyState icon={HardDrive} message="Select an organization to manage shared resources." />;
  }

  if (resourcesQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (resourcesQuery.error) {
    return <p className="text-sm text-destructive">{resourcesQuery.error.message}</p>;
  }

  const resourceItems = resourcesQuery.data ?? [];
  const workspacesPath = applyOrganizationPrefix("/workspaces", viewedOrganization.issuePrefix);
  const resourceDialogPending = createResource.isPending || updateResource.isPending;
  const resourceDialogTitle = editingResourceId ? "Edit resource" : "Add resource";
  const resourceDialogDescription = editingResourceId
    ? "Update the shared catalog entry. Projects that reference this resource will see the new metadata automatically."
    : "Add a shared repo, file, URL, or connector object that projects can attach directly.";

  return (
    <div className="flex min-h-full flex-col gap-4">
      <section className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card">
        <div className="grid gap-4 bg-[radial-gradient(circle_at_top_left,color-mix(in_oklab,var(--brand-primary)_14%,transparent),transparent_42%),linear-gradient(135deg,color-mix(in_oklab,var(--surface-elevated)_96%,transparent),var(--card))] px-5 py-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(18rem,0.9fr)]">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Layers3 className="h-3.5 w-3.5" />
              Org Resource Catalog
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">Resources</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Reusable repos, files, URLs, and connector objects for this organization. Keep entries canonical here,
                then attach them from projects with role-specific notes.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-[calc(var(--radius-sm)-1px)] border border-border/70 bg-background/55 px-2.5 py-1 text-xs text-muted-foreground">
                {resourceItems.length} catalog item{resourceItems.length === 1 ? "" : "s"}
              </span>
              <span className="rounded-[calc(var(--radius-sm)-1px)] border border-border/70 bg-background/55 px-2.5 py-1 text-xs text-muted-foreground">
                Project attachments add role + note
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="button" size="sm" onClick={openCreateResourceDialog}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add resource
              </Button>
              <Button asChild type="button" variant="outline" size="sm">
                <Link to={workspacesPath}>Browse workspaces</Link>
              </Button>
            </div>
          </div>

          <div className="rounded-[var(--radius-md)] border border-border/75 bg-background/72 p-4 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Agent Run Context
            </div>
            <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">
              <p>
                Organization resources are loaded as shared context for agent runs. Write descriptions like briefings,
                not labels.
              </p>
              <p>
                Project resources narrow the working set by attaching catalog items with a role and a project-specific
                note.
              </p>
              <p>
                Keep free-form notes or scratch files in <span className="font-mono">Workspaces</span>. This page is
                for structured, reusable references.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="text-sm font-medium text-foreground">Catalog</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Prefer durable names and concrete descriptions so agents can tell what matters without opening the target
            first.
          </div>
        </div>

        <div className="px-5 py-4">
          {resourceItems.length === 0 ? (
            <div className="rounded-[var(--radius-md)] border border-dashed border-border/80 bg-[color:color-mix(in_oklab,var(--surface-elevated)_84%,transparent)] px-5 py-9 text-sm text-muted-foreground">
              No org resources yet. Start with the main repo, the implementation spec, key URLs, or external systems
              agents should reference repeatedly.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {resourceItems.map((resource) => {
                const Icon = resourceKindIcon(resource.kind);
                return (
                  <div
                    key={resource.id}
                    className="flex h-full flex-col justify-between rounded-[var(--radius-md)] border border-border/75 bg-[color:color-mix(in_oklab,var(--surface-elevated)_94%,transparent)] p-4"
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <div className="rounded-md border border-border/70 bg-background/90 p-1.5 text-muted-foreground">
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">{resource.name}</div>
                            <div className="mt-1 inline-flex rounded-[calc(var(--radius-sm)-1px)] border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                              {organizationResourceKindLabel(resource.kind)}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground"
                            onClick={() => openEditResourceDialog(resource)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground"
                            onClick={() => removeResource.mutate(resource.id)}
                            disabled={removeResource.isPending}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>

                      <div className="break-all font-mono text-[11px] leading-5 text-muted-foreground">
                        {resource.locator}
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">
                        {resource.description || "No description yet."}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

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
                placeholder="What this resource contains and when agents should use it."
              />
            </label>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => closeResourceDialog(false)}
              disabled={resourceDialogPending}
            >
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
              disabled={
                resourceDialogPending
                || resourceDraft.name.trim().length === 0
                || resourceDraft.locator.trim().length === 0
              }
            >
              {resourceDialogPending ? "Saving…" : editingResourceId ? "Save changes" : "Create resource"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
