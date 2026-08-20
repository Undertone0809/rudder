import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNavigate } from "@/lib/router";
import type {
  CreateProjectInlineResourceInput,
  OrganizationResource,
  OrganizationResourceKind,
  OrganizationWorkspaceFileEntry,
  ProjectResourceAttachmentInput,
  ProjectResourceAttachmentRole,
} from "@rudderhq/shared";
import { PROJECT_COLORS } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  CircleHelp,
  Folder,
  LibraryBig,
  Link2,
  Maximize2,
  Minimize2,
  Plus,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { assetsApi } from "../api/assets";
import { organizationsApi } from "../api/orgs";
import { projectsApi } from "../api/projects";
import { useDialog } from "../context/DialogContext";
import { useI18n } from "../context/I18nContext";
import { useOrganization } from "../context/OrganizationContext";
import { libraryCopy } from "../lib/library-copy";
import { markdownDocumentOrUndefined } from "../lib/markdown-document-value";
import { queryKeys } from "../lib/queryKeys";
import {
  organizationResourceKindLabel,
  organizationResourceKindOptions,
  organizationResourceSourceTypeLabel,
} from "../lib/resource-options";
import { cn } from "../lib/utils";
import { AddSourcesDialog, isValidLibrarySourcePath } from "./AddSourcesDialog";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { ProjectIdentityPicker, ProjectIdentityTriggerButton } from "./ProjectIdentity";
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

function randomProjectColor() {
  return PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)] ?? PROJECT_COLORS[0];
}

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
  sourceType: "external" | "library";
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
    sourceType: "external",
    locator: "",
    description: "",
    role: "working_set",
    note: "",
  };
}

function isValidLibraryProjectPath(locator: string, kind: OrganizationResourceKind = "file") {
  return isValidLibrarySourcePath(locator, kind === "directory");
}

function libraryNameFromPath(locator: string) {
  const parts = locator.trim().split("/").filter(Boolean);
  return parts.at(-1) ?? locator.trim();
}

export function NewProjectDialog() {
  const { newProjectOpen, closeNewProject } = useDialog();
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("in_progress");
  const [color, setColor] = useState<string>(randomProjectColor);
  const [icon, setIcon] = useState("folder");
  const [targetDate, setTargetDate] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [resourceDrafts, setResourceDrafts] = useState<DraftProjectResource[]>([]);
  const [documentSessionId, setDocumentSessionId] = useState(0);

  const [statusOpen, setStatusOpen] = useState(false);
  const [addSourcesOpen, setAddSourcesOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

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
    setDocumentSessionId((current) => current + 1);
    setName("");
    setDescription("");
    setStatus("in_progress");
    setColor(randomProjectColor());
    setIcon("folder");
    setTargetDate("");
    setExpanded(false);
    setResourceDrafts([]);
    setAddSourcesOpen(false);
  }

  const existingResourceMap = new Map((organizationResources ?? []).map((resource) => [resource.id, resource]));
  const libraryResourceByLocator = new Map(
    (organizationResources ?? [])
      .filter((resource) => resource.sourceType === "library")
      .map((resource) => [resource.locator, resource]),
  );
  const selectedExistingResourceIds = new Set(
    resourceDrafts
      .filter((resource): resource is DraftAttachedResource => resource.kind === "existing")
      .map((resource) => resource.resourceId),
  );
  const selectedLibraryLocators = new Set(
    resourceDrafts.flatMap((resource) => {
      if (resource.kind === "new" && resource.sourceType === "library") return [resource.locator];
      if (resource.kind === "existing") {
        const existing = existingResourceMap.get(resource.resourceId);
        return existing?.sourceType === "library" ? [existing.locator] : [];
      }
      return [];
    }),
  );
  const hasInvalidInlineResources = resourceDrafts.some((resource) =>
    resource.kind === "new" && (
      !resource.name.trim()
      || !resource.locator.trim()
      || (resource.sourceType === "library" && !isValidLibraryProjectPath(resource.locator, resource.resourceKind))
    ),
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

  function openAddSourcesDialog() {
    setAddSourcesOpen(true);
  }

  function addExistingResources(resources: OrganizationResource[]) {
    setResourceDrafts((current) => {
      const attachedIds = new Set(
        current
          .filter((draft): draft is DraftAttachedResource => draft.kind === "existing")
          .map((draft) => draft.resourceId),
      );
      return [
        ...current,
        ...resources
          .filter((resource) => !attachedIds.has(resource.id))
          .map((resource): DraftAttachedResource => ({
            kind: "existing",
            resourceId: resource.id,
            role: resource.kind === "directory" ? "working_set" : "reference",
            note: "",
          })),
      ];
    });
  }

  function addExistingResource(resource: OrganizationResource) {
    addExistingResources([resource]);
  }

  function addLibraryResource(file: OrganizationWorkspaceFileEntry) {
    const existing = libraryResourceByLocator.get(file.path);
    if (existing) {
      addExistingResource(existing);
      return;
    }
    setResourceDrafts((current) => [
      ...current,
      {
        kind: "new",
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.displayLabel ?? file.name,
        resourceKind: file.isDirectory ? "directory" : "file",
        sourceType: "library",
        locator: file.path,
        description: "",
        role: file.isDirectory ? "working_set" : "reference",
        note: "",
      },
    ]);
  }

  function addLibraryResourcePath(locator: string) {
    const normalizedLocator = locator.trim();
    if (!isValidLibraryProjectPath(normalizedLocator)) return;
    const existing = libraryResourceByLocator.get(normalizedLocator);
    if (existing) {
      addExistingResource(existing);
      return;
    }
    setResourceDrafts((current) => [
      ...current,
      {
        kind: "new",
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: libraryNameFromPath(normalizedLocator),
        resourceKind: "file",
        sourceType: "library",
        locator: normalizedLocator,
        description: "",
        role: "reference",
        note: "",
      },
    ]);
  }

  function addInlineSource({
    kind,
    locator,
    name,
  }: {
    kind: "file" | "url";
    locator: string;
    name?: string;
  }) {
    setResourceDrafts((current) => [
      ...current,
      {
        ...createInlineResourceDraft(),
        name: name?.trim() || suggestResourceNameFromLocator(locator),
        resourceKind: kind,
        locator,
        role: "reference",
      },
    ]);
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
        sourceType: resource.sourceType,
        locator: resource.locator.trim(),
        description: resource.description.trim() || undefined,
        role: resource.role,
        note: resource.note.trim() || undefined,
        sortOrder: resourceAttachments.length + index,
      }));

    try {
      const created = await createProject.mutateAsync({
        name: name.trim(),
        description: markdownDocumentOrUndefined(description),
        status,
        color,
        icon,
        ...(targetDate ? { targetDate } : {}),
        ...(resourceAttachments.length > 0 ? { resourceAttachments } : {}),
        ...(newResources.length > 0 ? { newResources } : {}),
      });

      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedOrganizationId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(created.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.resources(selectedOrganizationId) });
      reset();
      closeNewProject();
      navigate(`/issues?projectId=${encodeURIComponent(created.id)}`);
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

  return (
    <>
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
        className={cn(
          "flex max-h-[min(860px,calc(100vh-2rem))] flex-col gap-0 overflow-visible p-0",
          expanded ? "sm:max-w-3xl" : "sm:max-w-xl",
        )}
        onKeyDown={handleKeyDown}
      >
        <DialogTitle className="sr-only">New project</DialogTitle>
        <DialogDescription className="sr-only">
          Create a project and choose the sources agents should use.
        </DialogDescription>
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
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

        <div
          data-testid="new-project-dialog-scroll"
          className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="shrink-0 px-4 pb-2 pt-4">
            <div className="flex items-center gap-3">
              <Popover>
                <PopoverTrigger asChild>
                  <ProjectIdentityTriggerButton
                    projectColor={color}
                    projectIcon={icon}
                    label="Choose project identity"
                    data-testid="new-project-identity-trigger"
                  />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto p-0">
                  <ProjectIdentityPicker
                    color={color}
                    icon={icon}
                    onColorChange={setColor}
                    onIconChange={setIcon}
                  />
                </PopoverContent>
              </Popover>
              <input
                className="min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground/50"
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
          </div>

          <div className="px-4 pb-2">
            <MarkdownEditor
              ref={descriptionEditorRef}
              engine="codemirror"
              documentIdentity={`new-project:${documentSessionId}`}
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

          <div className="space-y-3 border-t border-border px-4 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-center gap-1.5">
                <div className="text-sm font-medium">Project Sources</div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-5 w-5 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label="About project sources"
                    >
                      <CircleHelp className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={8} className="max-w-[260px] px-3 py-2 text-xs leading-5">
                    {libraryCopy("projectSourcesHelp", locale)}
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  size="xs"
                  className="h-7 rounded-[calc(var(--radius-sm)-1px)] px-2"
                  disabled={!selectedOrganizationId}
                  onClick={openAddSourcesDialog}
                >
                  <Plus className="mr-1.5 h-3 w-3" />
                  Add sources
                </Button>
              </div>
            </div>

            {resourceDrafts.length > 0 ? (
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
                              <span className="truncate">{existingResource?.name ?? "Missing resource"}</span>
                            </>
                          ) : resource.sourceType === "library" ? (
                            <>
                              <LibraryBig className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="truncate">{resource.name.trim() || resource.locator}</span>
                            </>
                          ) : (
                            <>
                              <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                              <span>{resource.name.trim() || "New resource"}</span>
                            </>
                          )}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {resource.kind === "existing"
                            ? existingResource
                              ? `${organizationResourceSourceTypeLabel(existingResource.sourceType)} · ${organizationResourceKindLabel(existingResource.kind)} · ${existingResource.locator}`
                              : "This resource is no longer available."
                            : resource.sourceType === "library"
                              ? `Library · ${organizationResourceKindLabel(resource.resourceKind)} · ${resource.locator}`
                              : "Created as an external resource and attached to this project on submit."}
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

                    {resource.kind === "new" && resource.sourceType === "external" ? (
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

                    <label className="block space-y-1">
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

                    {resource.kind === "new" && (!resource.name.trim() || !resource.locator.trim()) ? (
                      <p className="text-[11px] text-amber-600 dark:text-amber-300">
                        New resources need both a name and a locator before you can create the project.
                      </p>
                    ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-4 py-2">
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

        <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2.5">
          {createProject.isError ? (
            <p className="text-xs text-destructive">Failed to create project.</p>
          ) : (
            <span className="text-xs text-muted-foreground">
              {resourceDrafts.length > 0 ? `${resourceDrafts.length} source${resourceDrafts.length === 1 ? "" : "s"} queued` : ""}
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
    {selectedOrganizationId ? (
      <AddSourcesDialog
        open={addSourcesOpen}
        orgId={selectedOrganizationId}
        resources={organizationResources ?? []}
        excludedResourceIds={selectedExistingResourceIds}
        excludedLibraryLocators={selectedLibraryLocators}
        testId="new-project-add-sources-dialog"
        onOpenChange={setAddSourcesOpen}
        onAddExisting={addExistingResources}
        onAddLibraryFile={addLibraryResource}
        onAddLibraryPath={addLibraryResourcePath}
        onAddLocalFile={(locator) => addInlineSource({ kind: "file", locator })}
        onAddUrl={(locator) => addInlineSource({ kind: "url", locator })}
      />
    ) : null}
    </>
  );
}
