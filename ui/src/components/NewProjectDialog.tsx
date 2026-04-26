import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateProjectInlineResourceInput,
  OrganizationResource,
  OrganizationResourceKind,
  ProjectResourceAttachmentInput,
  ProjectResourceAttachmentRole,
} from "@rudderhq/shared";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { projectsApi } from "../api/projects";
import { goalsApi } from "../api/goals";
import { organizationsApi } from "../api/orgs";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import {
  organizationResourceKindOptions,
  organizationResourceKindLabel,
  projectResourceRoleOptions,
} from "../lib/resource-options";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Maximize2,
  Minimize2,
  Target,
  Calendar,
  Plus,
  X,
  Link2,
  Folder,
} from "lucide-react";
import { PROJECT_COLORS } from "@rudderhq/shared";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { ResourceLocatorField, suggestResourceNameFromLocator } from "./ResourceLocatorField";
import { StatusBadge } from "./StatusBadge";

const projectStatuses = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

const resourceControlClass =
  "w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_98%,transparent)] px-2.5 py-1.5 text-sm shadow-none outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

type DraftAttachedResource = {
  kind: "existing";
  resourceId: string;
  role: ProjectResourceAttachmentRole;
  note: string;
};

type DraftInlineResource = {
  kind: "new";
  id: string;
  name: string;
  resourceKind: OrganizationResourceKind;
  locator: string;
  description: string;
  role: ProjectResourceAttachmentRole;
  note: string;
};

type DraftProjectResource = DraftAttachedResource | DraftInlineResource;

function draftResourceKey(resource: DraftProjectResource) {
  return resource.kind === "existing" ? `existing:${resource.resourceId}` : `new:${resource.id}`;
}

function createInlineResourceDraft(): DraftInlineResource {
  return {
    kind: "new",
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    resourceKind: "directory",
    locator: "",
    description: "",
    role: "working_set",
    note: "",
  };
}

export function NewProjectDialog() {
  const { newProjectOpen, closeNewProject } = useDialog();
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [goalIds, setGoalIds] = useState<string[]>([]);
  const [targetDate, setTargetDate] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [resourceDrafts, setResourceDrafts] = useState<DraftProjectResource[]>([]);

  const [statusOpen, setStatusOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [resourcePickerOpen, setResourcePickerOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedOrganizationId!),
    queryFn: () => goalsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && newProjectOpen,
  });

  const { data: organizationResources } = useQuery({
    queryKey: queryKeys.organizations.resources(selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationsApi.listResources(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && newProjectOpen,
  });

  const createProject = useMutation({
    mutationFn: (data: Record<string, unknown> & {
      resourceAttachments?: ProjectResourceAttachmentInput[];
      newResources?: CreateProjectInlineResourceInput[];
    }) =>
      projectsApi.create(selectedOrganizationId!, data),
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedOrganizationId) throw new Error("No organization selected");
      return assetsApi.uploadImage(selectedOrganizationId, file, "projects/drafts");
    },
  });

  function reset() {
    setName("");
    setDescription("");
    setStatus("planned");
    setGoalIds([]);
    setTargetDate("");
    setExpanded(false);
    setResourceDrafts([]);
  }

  const existingResourceMap = new Map((organizationResources ?? []).map((resource) => [resource.id, resource]));
  const selectedExistingResourceIds = new Set(
    resourceDrafts
      .filter((resource): resource is DraftAttachedResource => resource.kind === "existing")
      .map((resource) => resource.resourceId),
  );
  const availableResources = (organizationResources ?? []).filter((resource) => !selectedExistingResourceIds.has(resource.id));
  const hasInvalidInlineResources = resourceDrafts.some((resource) =>
    resource.kind === "new" && (!resource.name.trim() || !resource.locator.trim()),
  );

  function updateDraftResource(
    key: string,
    updater: (resource: DraftProjectResource) => DraftProjectResource,
  ) {
    setResourceDrafts((current) => current.map((resource) => (
      draftResourceKey(resource) === key ? updater(resource) : resource
    )));
  }

  function removeDraftResource(key: string) {
    setResourceDrafts((current) => current.filter((resource) => draftResourceKey(resource) !== key));
  }

  function addExistingResource(resource: OrganizationResource) {
    setResourceDrafts((current) => [
      ...current,
      {
        kind: "existing",
        resourceId: resource.id,
        role: "reference",
        note: "",
      },
    ]);
    setResourcePickerOpen(false);
  }

  async function handleSubmit() {
    if (!selectedOrganizationId || !name.trim() || hasInvalidInlineResources) return;

    const resourceAttachments = resourceDrafts
      .filter((resource): resource is DraftAttachedResource => resource.kind === "existing")
      .map((resource, index) => ({
        resourceId: resource.resourceId,
        role: resource.role,
        note: resource.note.trim() || undefined,
        sortOrder: index,
      }));

    const newResources = resourceDrafts
      .filter((resource): resource is DraftInlineResource => resource.kind === "new")
      .map((resource, index) => ({
        name: resource.name.trim(),
        kind: resource.resourceKind,
        locator: resource.locator.trim(),
        description: resource.description.trim() || undefined,
        role: resource.role,
        note: resource.note.trim() || undefined,
        sortOrder: resourceAttachments.length + index,
      }));

    try {
      const created = await createProject.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        status,
        color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
        ...(goalIds.length > 0 ? { goalIds } : {}),
        ...(targetDate ? { targetDate } : {}),
        ...(resourceAttachments.length > 0 ? { resourceAttachments } : {}),
        ...(newResources.length > 0 ? { newResources } : {}),
      });

      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedOrganizationId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(created.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.resources(selectedOrganizationId) });
      reset();
      closeNewProject();
    } catch {
      // surface through createProject.isError
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  const selectedGoals = (goals ?? []).filter((g) => goalIds.includes(g.id));
  const availableGoals = (goals ?? []).filter((g) => !goalIds.includes(g.id));

  return (
    <Dialog
      open={newProjectOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewProject();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("p-0 gap-0", expanded ? "sm:max-w-3xl" : "sm:max-w-xl")}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedOrganization && (
              <span className="rounded-[calc(var(--radius-sm)-1px)] bg-muted px-1.5 py-0.5 text-xs font-medium">
                {selectedOrganization.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>New project</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => { reset(); closeNewProject(); }}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        <div className="px-4 pt-4 pb-2 shrink-0">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        <div className="px-4 pb-2">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            contentClassName={cn("text-sm text-muted-foreground", expanded ? "min-h-[200px]" : "min-h-[120px]")}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        <div className="border-t border-border px-4 py-3 space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <div className="text-sm font-medium">Resources</div>
              <p className="text-xs text-muted-foreground">
                Attach the codebases, docs, URLs, and external systems agents should use for this project.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <Popover open={resourcePickerOpen} onOpenChange={setResourcePickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="h-7 rounded-[calc(var(--radius-sm)-1px)] px-2"
                    disabled={!selectedOrganizationId || (organizationResources ?? []).length === 0 || availableResources.length === 0}
                  >
                    <Link2 className="mr-1.5 h-3 w-3" />
                    Attach org resource
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-1" align="end">
                  {availableResources.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No unattached org resources available.
                    </div>
                  ) : (
                    availableResources.map((resource) => (
                      <button
                        key={resource.id}
                        type="button"
                        className="w-full rounded-[calc(var(--radius-sm)-1px)] px-2 py-2 text-left hover:bg-accent/50"
                        onClick={() => addExistingResource(resource)}
                      >
                        <div className="text-xs font-medium">{resource.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {organizationResourceKindLabel(resource.kind)} · {resource.locator}
                        </div>
                      </button>
                    ))
                  )}
                </PopoverContent>
              </Popover>

              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-7 rounded-[calc(var(--radius-sm)-1px)] px-2"
                onClick={() => setResourceDrafts((current) => [...current, createInlineResourceDraft()])}
              >
                <Plus className="mr-1.5 h-3 w-3" />
                New resource
              </Button>
            </div>
          </div>

          {resourceDrafts.length === 0 ? (
            <div className="rounded-[var(--radius-sm)] border border-dashed border-border/80 px-3 py-3 text-xs text-muted-foreground">
              No project-specific resources yet. You can still create the project now and attach resources later.
            </div>
          ) : (
            <div className="space-y-3">
              {resourceDrafts.map((resource) => {
                const key = draftResourceKey(resource);
                const existingResource = resource.kind === "existing"
                  ? existingResourceMap.get(resource.resourceId) ?? null
                  : null;

                return (
                  <div
                    key={key}
                    className="space-y-3 rounded-[var(--radius-sm)] border border-border/80 bg-[color:color-mix(in_oklab,var(--surface-inset)_52%,var(--surface-elevated))] px-3 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-0.5 min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {resource.kind === "existing" ? (
                            <>
                              <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="truncate">{existingResource?.name ?? "Missing org resource"}</span>
                            </>
                          ) : (
                            <>
                              <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                              <span>{resource.name.trim() || "New org resource"}</span>
                            </>
                          )}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {resource.kind === "existing"
                            ? existingResource
                              ? `${organizationResourceKindLabel(existingResource.kind)} · ${existingResource.locator}`
                              : "This org resource is no longer available."
                            : "Created in the org catalog and attached to this project on submit."}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground"
                        onClick={() => removeDraftResource(key)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    {resource.kind === "new" ? (
                      <div className="grid gap-2 md:grid-cols-2">
                        <label className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">Name</span>
                          <input
                            value={resource.name}
                            onChange={(event) => updateDraftResource(key, (current) => ({
                              ...(current as DraftInlineResource),
                              name: event.target.value,
                            }))}
                            className={resourceControlClass}
                            placeholder="Rudder repo"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[11px] text-muted-foreground">Kind</span>
                          <select
                            value={resource.resourceKind}
                            onChange={(event) => updateDraftResource(key, (current) => ({
                              ...(current as DraftInlineResource),
                              resourceKind: event.target.value as OrganizationResourceKind,
                            }))}
                            className={cn(resourceControlClass, "h-8")}
                          >
                            {organizationResourceKindOptions.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className="space-y-1 md:col-span-2">
                          <span className="text-[11px] text-muted-foreground">Locator</span>
                          <ResourceLocatorField
                            kind={resource.resourceKind}
                            value={resource.locator}
                            onChange={(locator) => updateDraftResource(key, (current) => ({
                              ...(current as DraftInlineResource),
                              locator,
                            }))}
                            onPickedPath={(locator) => updateDraftResource(key, (current) => {
                              const draft = current as DraftInlineResource;
                              return {
                                ...draft,
                                locator,
                                name: draft.name.trim() ? draft.name : suggestResourceNameFromLocator(locator),
                              };
                            })}
                            inputClassName={cn(resourceControlClass, "h-8")}
                            buttonClassName="h-8 rounded-[calc(var(--radius-sm)-1px)]"
                          />
                        </label>
                        <label className="space-y-1 md:col-span-2">
                          <span className="text-[11px] text-muted-foreground">Description</span>
                          <textarea
                            value={resource.description}
                            onChange={(event) => updateDraftResource(key, (current) => ({
                              ...(current as DraftInlineResource),
                              description: event.target.value,
                            }))}
                            className={cn(resourceControlClass, "min-h-[72px] resize-y py-2")}
                            placeholder="What this resource contains and when agents should use it."
                          />
                        </label>
                      </div>
                    ) : null}

                    <div className="grid gap-2 md:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-[11px] text-muted-foreground">Project role</span>
                        <select
                          value={resource.role}
                          onChange={(event) => updateDraftResource(key, (current) => ({
                            ...current,
                            role: event.target.value as ProjectResourceAttachmentRole,
                          }))}
                          className={cn(resourceControlClass, "h-8")}
                        >
                          {projectResourceRoleOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-[11px] text-muted-foreground">Project note</span>
                        <input
                          value={resource.note}
                          onChange={(event) => updateDraftResource(key, (current) => ({
                            ...current,
                            note: event.target.value,
                          }))}
                          className={resourceControlClass}
                          placeholder="Optional guidance specific to this project"
                        />
                      </label>
                    </div>

                    {resource.kind === "new" && (!resource.name.trim() || !resource.locator.trim()) ? (
                      <p className="text-[11px] text-amber-600 dark:text-amber-300">
                        New resources need both a name and a locator before you can create the project.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center rounded-[calc(var(--radius-sm)-1px)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <StatusBadge status={status} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {projectStatuses.map((s) => (
                <button
                  key={s.value}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-2 py-1.5 text-xs hover:bg-accent/50",
                    s.value === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  {s.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {selectedGoals.map((goal) => (
            <span
              key={goal.id}
              className="inline-flex items-center gap-1 rounded-[calc(var(--radius-sm)-1px)] border border-border px-2 py-1 text-xs"
            >
              <Target className="h-3 w-3 text-muted-foreground" />
              <span className="max-w-[160px] truncate">{goal.title}</span>
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setGoalIds((prev) => prev.filter((id) => id !== goal.id))}
                aria-label={`Remove goal ${goal.title}`}
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}

          <Popover open={goalOpen} onOpenChange={setGoalOpen}>
            <PopoverTrigger asChild>
              <button
                className="inline-flex items-center gap-1.5 rounded-[calc(var(--radius-sm)-1px)] border border-border px-2 py-1 text-xs transition-colors hover:bg-accent/50 disabled:opacity-60"
                disabled={selectedGoals.length > 0 && availableGoals.length === 0}
              >
                {selectedGoals.length > 0 ? <Plus className="h-3 w-3 text-muted-foreground" /> : <Target className="h-3 w-3 text-muted-foreground" />}
                {selectedGoals.length > 0 ? "+ Goal" : "Goal"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
              {selectedGoals.length === 0 && (
                <button
                  className="flex w-full items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/50"
                  onClick={() => setGoalOpen(false)}
                >
                  No goal
                </button>
              )}
              {availableGoals.map((g) => (
                <button
                  key={g.id}
                  className="flex w-full items-center gap-2 truncate rounded-[calc(var(--radius-sm)-1px)] px-2 py-1.5 text-xs hover:bg-accent/50"
                  onClick={() => {
                    setGoalIds((prev) => [...prev, g.id]);
                    setGoalOpen(false);
                  }}
                >
                  {g.title}
                </button>
              ))}
              {selectedGoals.length > 0 && availableGoals.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  All goals already selected.
                </div>
              )}
            </PopoverContent>
          </Popover>

          <div className="inline-flex items-center gap-1.5 rounded-[calc(var(--radius-sm)-1px)] border border-border px-2 py-1 text-xs">
            <Calendar className="h-3 w-3 text-muted-foreground" />
            <input
              type="date"
              className="bg-transparent outline-none text-xs w-24"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              placeholder="Target date"
            />
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          {createProject.isError ? (
            <p className="text-xs text-destructive">Failed to create project.</p>
          ) : (
            <span className="text-xs text-muted-foreground">
              {resourceDrafts.length > 0 ? `${resourceDrafts.length} resource${resourceDrafts.length === 1 ? "" : "s"} queued` : ""}
            </span>
          )}
          <Button
            size="sm"
            disabled={!name.trim() || createProject.isPending || hasInvalidInlineResources}
            onClick={() => void handleSubmit()}
          >
            {createProject.isPending ? "Creating…" : "Create project"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
