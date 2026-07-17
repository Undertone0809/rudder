import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Project, ProjectResourceAttachment } from "@rudderhq/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, FolderOpen, Loader2, Pencil, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { organizationsApi } from "../../api/orgs";
import { projectsApi } from "../../api/projects";
import { ResourceLocatorField } from "../../components/ResourceLocatorField";
import { WorkspaceLaunchTargetIcon } from "../../components/workspaces/WorkspaceLaunchControls";
import { useToast } from "../../context/ToastContext";
import { readDesktopShell, type DesktopWorkspaceLaunchTarget } from "../../lib/desktop-shell";
import { queryKeys } from "../../lib/queryKeys";
import { organizationResourceKindLabel, organizationResourceSourceTypeLabel } from "../../lib/resource-options";
import type { WorkspaceOpenTargetId } from "../../lib/workspace-preferences";
import { cn } from "../../lib/utils";
import { isHttpUrl, resolveResourceOpenPath } from "./organizationWorkspaceCapabilities";

function ResourceMetadataRow({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid gap-1 border-b border-border/60 py-3 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("min-w-0 text-sm text-foreground", mono && "break-all font-mono text-xs")}>{children}</div>
    </div>
  );
}

type ProjectResourceEditDraft = { name: string; locator: string; description: string; note: string };

function createProjectResourceEditDraft(attachment: ProjectResourceAttachment): ProjectResourceEditDraft {
  return {
    name: attachment.resource.name,
    locator: attachment.resource.locator,
    description: attachment.resource.description ?? "",
    note: attachment.note ?? "",
  };
}

export function ProjectResourceDetailPanel({
  project,
  attachment,
  workspaceRootPath,
  workspaceLaunchTargets,
  selectedWorkspaceLaunchTarget,
  openingWorkspaceTargetId,
  onSelectWorkspaceLaunchTarget,
  onOpenWorkspaceTarget,
}: {
  project: Project;
  attachment: ProjectResourceAttachment;
  workspaceRootPath: string | null;
  workspaceLaunchTargets: DesktopWorkspaceLaunchTarget[];
  selectedWorkspaceLaunchTarget: DesktopWorkspaceLaunchTarget | null;
  openingWorkspaceTargetId: WorkspaceOpenTargetId | null;
  onSelectWorkspaceLaunchTarget: (target: DesktopWorkspaceLaunchTarget) => void;
  onOpenWorkspaceTarget: (rootPath: string, target: DesktopWorkspaceLaunchTarget, toastLabel?: string) => void;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [resourceDraft, setResourceDraft] = useState(() => createProjectResourceEditDraft(attachment));
  const [openingPath, setOpeningPath] = useState(false);
  const [openingExternal, setOpeningExternal] = useState(false);
  const locator = attachment.resource.locator.trim();
  const resourceOpenPath = resolveResourceOpenPath(attachment, workspaceRootPath);
  const canOpenAsWorkspace = Boolean(resourceOpenPath && attachment.resource.kind === "directory" && selectedWorkspaceLaunchTarget && workspaceLaunchTargets.length > 0);
  const canOpenStandalonePath = Boolean(resourceOpenPath && readDesktopShell()?.openPath && !canOpenAsWorkspace);
  const canOpenExternal = attachment.resource.kind === "url" || isHttpUrl(locator);

  useEffect(() => {
    setEditing(false);
    setResourceDraft(createProjectResourceEditDraft(attachment));
  }, [attachment.id, attachment.note, attachment.resource.description, attachment.resource.locator, attachment.resource.name]);

  const updateResourceDetails = useMutation({
    mutationFn: async (draft: ProjectResourceEditDraft) => {
      const name = draft.name.trim();
      const nextLocator = draft.locator.trim();
      if (!name) throw new Error("Resource name is required.");
      if (!nextLocator) throw new Error("Resource locator is required.");
      const updatedResource = await organizationsApi.updateResource(project.orgId, attachment.resourceId, {
        name,
        locator: nextLocator,
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
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(project.orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.resources(project.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.resources(project.orgId) });
      pushToast({ title: "Resource updated", tone: "success" });
    },
    onError: (error) => pushToast({ title: error instanceof Error ? error.message : "Failed to update resource", tone: "error" }),
  });

  async function handleOpenPath() {
    if (!resourceOpenPath) return;
    const desktopShell = readDesktopShell();
    if (!desktopShell?.openPath) return;
    setOpeningPath(true);
    try {
      await desktopShell.openPath(resourceOpenPath);
      pushToast({ title: attachment.resource.kind === "directory" ? "Opened resource folder" : "Opened resource file", body: resourceOpenPath, tone: "info" });
    } catch (error) {
      pushToast({ title: "Failed to open resource", body: error instanceof Error ? error.message : resourceOpenPath, tone: "error" });
    } finally {
      setOpeningPath(false);
    }
  }

  async function handleOpenExternal() {
    if (!locator) return;
    const desktopShell = readDesktopShell();
    setOpeningExternal(true);
    try {
      if (desktopShell?.openExternal) await desktopShell.openExternal(locator);
      else window.open(locator, "_blank", "noopener,noreferrer");
      pushToast({ title: "Opened resource link", body: locator, tone: "info" });
    } catch (error) {
      pushToast({ title: "Failed to open resource link", body: error instanceof Error ? error.message : locator, tone: "error" });
    } finally {
      setOpeningExternal(false);
    }
  }

  return (
    <div data-testid="org-workspaces-resource-detail" className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border bg-[color:var(--surface-elevated)] px-5 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-base font-semibold text-foreground">{attachment.resource.name}</h3>
              <span className="rounded-[calc(var(--radius-sm)-1px)] border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {organizationResourceSourceTypeLabel(attachment.resource.sourceType)} · {organizationResourceKindLabel(attachment.resource.kind)}
              </span>
            </div>
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{locator}</div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button type="button" variant={editing ? "secondary" : "outline"} size="sm" onClick={() => {
              setResourceDraft(createProjectResourceEditDraft(attachment));
              setEditing(true);
            }} disabled={updateResourceDetails.isPending} data-testid="org-workspaces-resource-edit">
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
            {canOpenExternal ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void handleOpenExternal()} disabled={openingExternal} data-testid="org-workspaces-resource-open-external">
                {openingExternal ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                Open
              </Button>
            ) : null}
            {canOpenStandalonePath ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void handleOpenPath()} disabled={openingPath} data-testid="org-workspaces-resource-open-path">
                {openingPath ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
                Open
              </Button>
            ) : null}
            {canOpenAsWorkspace && selectedWorkspaceLaunchTarget && resourceOpenPath ? (
              <div className="inline-flex h-9 items-stretch overflow-hidden rounded-[18px] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] shadow-none" data-testid="org-workspaces-resource-launcher">
                <Button type="button" variant="ghost" size="icon" className="h-full w-9 rounded-none border-0 text-foreground shadow-none hover:border-0 hover:bg-[color:var(--surface-active)]" aria-label={`Open resource in ${selectedWorkspaceLaunchTarget.label}`} onClick={() => onOpenWorkspaceTarget(resourceOpenPath, selectedWorkspaceLaunchTarget, "resource")} disabled={openingWorkspaceTargetId !== null}>
                  {openingWorkspaceTargetId === selectedWorkspaceLaunchTarget.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <WorkspaceLaunchTargetIcon target={selectedWorkspaceLaunchTarget} />}
                </Button>
                <div className="my-1 w-px bg-[color:var(--border-soft)]" aria-hidden="true" />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="h-full w-9 rounded-none border-0 text-muted-foreground shadow-none hover:border-0 hover:bg-[color:var(--surface-active)] hover:text-foreground" aria-label="Open resource menu" disabled={openingWorkspaceTargetId !== null}>
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56 whitespace-nowrap">
                    <DropdownMenuRadioGroup value={selectedWorkspaceLaunchTarget.id} onValueChange={(targetId) => {
                      const target = workspaceLaunchTargets.find((candidate) => candidate.id === targetId);
                      if (target) onSelectWorkspaceLaunchTarget(target);
                    }}>
                      {workspaceLaunchTargets.map((target) => (
                        <DropdownMenuRadioItem key={target.id} value={target.id} data-testid={`org-workspaces-resource-launch-target-${target.id}`}>
                          <WorkspaceLaunchTargetIcon target={target} />
                          <span>{target.label}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="max-w-3xl">
          {editing ? (
            <div className="grid gap-4 md:grid-cols-2" data-testid="org-workspaces-resource-edit-form">
              <label className="space-y-1.5">
                <span className="text-xs text-muted-foreground">Name</span>
                <Input value={resourceDraft.name} onChange={(event) => setResourceDraft((current) => ({ ...current, name: event.target.value }))} disabled={updateResourceDetails.isPending} />
              </label>
              <label className="space-y-1.5 md:col-span-2">
                <span className="text-xs text-muted-foreground">Locator</span>
                <ResourceLocatorField kind={attachment.resource.kind} value={resourceDraft.locator} onChange={(locator) => setResourceDraft((current) => ({ ...current, locator }))} disabled={updateResourceDetails.isPending} />
              </label>
              <label className="space-y-1.5 md:col-span-2">
                <span className="text-xs text-muted-foreground">Description</span>
                <Textarea value={resourceDraft.description} onChange={(event) => setResourceDraft((current) => ({ ...current, description: event.target.value }))} placeholder="What this resource contains and when agents should use it." disabled={updateResourceDetails.isPending} />
              </label>
              <label className="space-y-1.5 md:col-span-2">
                <span className="text-xs text-muted-foreground">Project note</span>
                <Input value={resourceDraft.note} onChange={(event) => setResourceDraft((current) => ({ ...current, note: event.target.value }))} placeholder="Optional project-specific guidance for agents" disabled={updateResourceDetails.isPending} />
              </label>
              <div className="flex justify-end gap-2 md:col-span-2">
                <Button type="button" variant="outline" size="sm" onClick={() => {
                  setResourceDraft(createProjectResourceEditDraft(attachment));
                  setEditing(false);
                }} disabled={updateResourceDetails.isPending}>
                  <X className="h-3.5 w-3.5" />
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={() => updateResourceDetails.mutate(resourceDraft)} disabled={updateResourceDetails.isPending || !resourceDraft.name.trim() || !resourceDraft.locator.trim()}>
                  {updateResourceDetails.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <>
              <ResourceMetadataRow label="Project">{project.name}</ResourceMetadataRow>
              <ResourceMetadataRow label="Source">{organizationResourceSourceTypeLabel(attachment.resource.sourceType)} · {organizationResourceKindLabel(attachment.resource.kind)}</ResourceMetadataRow>
              <ResourceMetadataRow label="Locator" mono>{locator}</ResourceMetadataRow>
              <ResourceMetadataRow label="Description">{attachment.resource.description?.trim() || <span className="text-muted-foreground">No description.</span>}</ResourceMetadataRow>
              <ResourceMetadataRow label="Project note">{attachment.note?.trim() || <span className="text-muted-foreground">No project-specific note.</span>}</ResourceMetadataRow>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
