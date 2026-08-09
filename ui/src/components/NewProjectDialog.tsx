import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
  ArrowLeft,
  Calendar,
  CircleHelp,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  LibraryBig,
  Link2,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  Target,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { assetsApi } from "../api/assets";
import { goalsApi } from "../api/goals";
import { instanceSettingsApi } from "../api/instanceSettings";
import { organizationsApi } from "../api/orgs";
import { projectsApi } from "../api/projects";
import { useDialog } from "../context/DialogContext";
import { useI18n } from "../context/I18nContext";
import { useOrganization } from "../context/OrganizationContext";
import { useExperimentalGoalsEnabled } from "../hooks/useExperimentalGoalsEnabled";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { libraryCopy } from "../lib/library-copy";
import { markdownDocumentOrUndefined } from "../lib/markdown-document-value";
import { queryKeys } from "../lib/queryKeys";
import {
  organizationResourceKindLabel,
  organizationResourceKindOptions,
  organizationResourceSourceTypeLabel,
} from "../lib/resource-options";
import { cn } from "../lib/utils";
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

type AddSourcesView = "choose" | "library" | "local" | "url";

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

const LIBRARY_PATH_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function isValidLibraryProjectPath(locator: string, kind: OrganizationResourceKind = "file") {
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

function isHttpUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resourceUpdatedAt(resource: OrganizationResource) {
  const timestamp = new Date(resource.updatedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
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
  const [goalIds, setGoalIds] = useState<string[]>([]);
  const [targetDate, setTargetDate] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [resourceDrafts, setResourceDrafts] = useState<DraftProjectResource[]>([]);
  const [documentSessionId, setDocumentSessionId] = useState(0);

  const [statusOpen, setStatusOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [addSourcesView, setAddSourcesView] = useState<AddSourcesView | null>(null);
  const [librarySearch, setLibrarySearch] = useState("");
  const [selectedLocalResourceIds, setSelectedLocalResourceIds] = useState<string[]>([]);
  const [urlSource, setUrlSource] = useState("");
  const [localPathPicking, setLocalPathPicking] = useState(false);
  const [sourceDialogError, setSourceDialogError] = useState<string | null>(null);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const librarySourcesScrollRef = useScrollbarActivityRef();
  const localSourcesScrollRef = useScrollbarActivityRef();
  const { enabled: goalsEnabled } = useExperimentalGoalsEnabled();

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedOrganizationId!),
    queryFn: () => goalsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && newProjectOpen && goalsEnabled,
  });
  useEffect(() => {
    if (!goalsEnabled) setGoalIds([]);
  }, [goalsEnabled]);

  const { data: organizationResources } = useQuery({
    queryKey: queryKeys.organizations.resources(selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationsApi.listResources(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && newProjectOpen,
  });

  const { data: libraryMentionFiles } = useQuery({
    queryKey: queryKeys.organizations.workspaceMentionFiles(selectedOrganizationId ?? "__none__", librarySearch),
    queryFn: () => organizationsApi.listWorkspaceMentionFiles(selectedOrganizationId!, {
      query: librarySearch,
      limit: 24,
    }),
    enabled: !!selectedOrganizationId && newProjectOpen && addSourcesView === "library",
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
    setGoalIds([]);
    setTargetDate("");
    setExpanded(false);
    setResourceDrafts([]);
    setLibrarySearch("");
    setSelectedLocalResourceIds([]);
    setUrlSource("");
    setAddSourcesView(null);
    setLocalPathPicking(false);
    setSourceDialogError(null);
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
  const availableResources = (organizationResources ?? []).filter((resource) => !selectedExistingResourceIds.has(resource.id));
  const recentLocalResources = availableResources
    .filter((resource) => resource.sourceType === "external" && (resource.kind === "file" || resource.kind === "directory"))
    .sort((left, right) => resourceUpdatedAt(right) - resourceUpdatedAt(left));
  const libraryFileEntries = Array.isArray(libraryMentionFiles?.entries) ? libraryMentionFiles.entries : [];
  const availableLibraryFiles = libraryFileEntries.filter((entry) =>
    isValidLibraryProjectPath(entry.path, entry.isDirectory ? "directory" : "file")
    && !selectedLibraryLocators.has(entry.path),
  );
  const normalizedLibrarySearch = librarySearch.trim();
  const canAddLibrarySearchPath =
    isValidLibraryProjectPath(normalizedLibrarySearch)
    && !selectedLibraryLocators.has(normalizedLibrarySearch)
    && !availableLibraryFiles.some((entry) => entry.path === normalizedLibrarySearch);
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

  function closeAddSourcesDialog() {
    setAddSourcesView(null);
    setLibrarySearch("");
    setSelectedLocalResourceIds([]);
    setUrlSource("");
    setSourceDialogError(null);
  }

  function openAddSourcesDialog() {
    setAddSourcesView("choose");
    setSourceDialogError(null);
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
    closeAddSourcesDialog();
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
    closeAddSourcesDialog();
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
    closeAddSourcesDialog();
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
    closeAddSourcesDialog();
  }

  async function chooseLocalFile() {
    if (localPathPicking) return;
    setLocalPathPicking(true);
    setSourceDialogError(null);
    try {
      const result = await instanceSettingsApi.pickPath({ selectionType: "file" });
      if (!result.cancelled && result.path) {
        addInlineSource({ kind: "file", locator: result.path });
      }
    } catch {
      setSourceDialogError("Could not open the file picker. Try again from the Rudder Desktop app.");
    } finally {
      setLocalPathPicking(false);
    }
  }

  function addSelectedLocalSources() {
    const selectedIds = new Set(selectedLocalResourceIds);
    addExistingResources(recentLocalResources.filter((resource) => selectedIds.has(resource.id)));
  }

  function addUrlSource() {
    const locator = urlSource.trim();
    if (!isHttpUrl(locator)) return;
    addInlineSource({ kind: "url", locator });
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

  const selectedGoals = (goals ?? []).filter((g) => goalIds.includes(g.id));
  const availableGoals = (goals ?? []).filter((g) => !goalIds.includes(g.id));

  const sourceDialogTitle = addSourcesView === "library"
    ? "Add from library"
    : addSourcesView === "local"
      ? "Select from local"
      : addSourcesView === "url"
        ? "Add from URL"
        : "Add sources";

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

          {goalsEnabled && selectedGoals.map((goal) => (
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

          {goalsEnabled ? <Popover open={goalOpen} onOpenChange={setGoalOpen}>
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
          </Popover> : null}

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
    <Dialog
      open={addSourcesView !== null}
      onOpenChange={(open) => {
        if (!open) closeAddSourcesDialog();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="isolate flex max-h-[min(680px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 before:absolute before:inset-0 before:-z-10 before:bg-card sm:max-w-lg"
        data-testid="new-project-add-sources-dialog"
      >
        <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {addSourcesView && addSourcesView !== "choose" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Back to source types"
                onClick={() => {
                  setAddSourcesView("choose");
                  setSourceDialogError(null);
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <DialogTitle className="truncate text-base font-medium">{sourceDialogTitle}</DialogTitle>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label="Close add sources"
            onClick={closeAddSourcesDialog}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {addSourcesView === "choose" ? (
          <div className="grid gap-2 p-4">
            {[
              {
                view: "library" as const,
                label: "Add from library",
                detail: "Reuse files already in this organization",
                icon: LibraryBig,
              },
              {
                view: "local" as const,
                label: "Select from local",
                detail: "Reuse recent sources or choose a file",
                icon: FolderOpen,
              },
              {
                view: "url" as const,
                label: "Add from URL",
                detail: "Link a webpage or remote reference",
                icon: Globe2,
              },
            ].map((option) => (
              <button
                key={option.view}
                type="button"
                className="group flex w-full items-center gap-3 rounded-[var(--radius-sm)] border border-border/80 px-3 py-3 text-left transition-colors hover:border-border-strong hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setAddSourcesView(option.view)}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] border border-border/70 bg-muted/40 text-muted-foreground group-hover:text-foreground">
                  <option.icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{option.detail}</span>
                </span>
                <span className="text-muted-foreground">&rsaquo;</span>
              </button>
            ))}
          </div>
        ) : null}

        {addSourcesView === "library" ? (
          <>
            <div className="shrink-0 border-b border-border px-4 py-3">
              <input
                value={librarySearch}
                onChange={(event) => setLibrarySearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canAddLibrarySearchPath) {
                    event.preventDefault();
                    addLibraryResourcePath(normalizedLibrarySearch);
                  }
                }}
                className={cn(resourceControlClass, "h-8")}
                placeholder={libraryCopy("searchLibraryPlaceholder", locale)}
                autoFocus
              />
            </div>
            <div
              ref={librarySourcesScrollRef}
              data-testid="new-project-library-sources-scroll"
              className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
            >
              {availableLibraryFiles.length === 0 && !canAddLibrarySearchPath ? (
                <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                  {librarySearch.trim() ? libraryCopy("noMatchingLibraryFiles", locale) : libraryCopy("noLibraryFiles", locale)}
                </div>
              ) : availableLibraryFiles.map((file) => {
                const Icon = file.isDirectory ? Folder : FileText;
                return (
                  <button
                    key={file.path}
                    type="button"
                    className="flex w-full items-start gap-3 rounded-[calc(var(--radius-sm)-1px)] px-2 py-2.5 text-left hover:bg-accent/50"
                    onClick={() => addLibraryResource(file)}
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{file.displayLabel ?? file.name}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{file.path}</span>
                    </span>
                  </button>
                );
              })}
              {canAddLibrarySearchPath ? (
                <button
                  type="button"
                  className="flex w-full items-start gap-3 rounded-[calc(var(--radius-sm)-1px)] px-2 py-2.5 text-left hover:bg-accent/50"
                  onClick={() => addLibraryResourcePath(normalizedLibrarySearch)}
                >
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{libraryCopy("useThisLibraryPath", locale)}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{normalizedLibrarySearch}</span>
                  </span>
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {addSourcesView === "local" ? (
          <>
            <div className="flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium">Recent sources</div>
                <div className="mt-0.5 text-xs text-muted-foreground">Select one or more to add again.</div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={localPathPicking}
                onClick={() => void chooseLocalFile()}
              >
                {localPathPicking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
                Choose file
              </Button>
            </div>
            <div
              ref={localSourcesScrollRef}
              data-testid="new-project-local-sources-scroll"
              className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain"
            >
              {recentLocalResources.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">No recent local sources yet.</div>
              ) : recentLocalResources.map((resource) => {
                const selected = selectedLocalResourceIds.includes(resource.id);
                const Icon = resource.kind === "directory" ? Folder : FileText;
                return (
                  <label
                    key={resource.id}
                    className="flex cursor-pointer items-center gap-3 border-b border-border/70 px-4 py-3 transition-colors last:border-b-0 hover:bg-accent/30"
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => setSelectedLocalResourceIds((current) => (
                        event.target.checked
                          ? [...current, resource.id]
                          : current.filter((id) => id !== resource.id)
                      ))}
                      className="h-4 w-4 shrink-0 accent-primary"
                    />
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{resource.name}</span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{resource.locator}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {sourceDialogError ? (
              <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-destructive">{sourceDialogError}</p>
            ) : null}
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3">
              <span className="text-xs text-muted-foreground">
                {selectedLocalResourceIds.length === 0
                  ? "No sources selected"
                  : `${selectedLocalResourceIds.length} source${selectedLocalResourceIds.length === 1 ? "" : "s"} selected`}
              </span>
              <Button
                type="button"
                size="sm"
                disabled={selectedLocalResourceIds.length === 0}
                onClick={addSelectedLocalSources}
              >
                Add sources
              </Button>
            </div>
          </>
        ) : null}

        {addSourcesView === "url" ? (
          <>
            <div className="grid gap-2 p-4">
              <label htmlFor="new-project-source-url" className="text-xs text-muted-foreground">URL</label>
              <input
                id="new-project-source-url"
                type="url"
                value={urlSource}
                onChange={(event) => setUrlSource(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && isHttpUrl(urlSource)) {
                    event.preventDefault();
                    addUrlSource();
                  }
                }}
                className={cn(resourceControlClass, "h-9")}
                placeholder="https://example.com/reference"
                autoFocus
              />
              {urlSource.trim() && !isHttpUrl(urlSource) ? (
                <p className="text-xs text-destructive">Enter a valid http:// or https:// URL.</p>
              ) : null}
            </div>
            <div className="flex shrink-0 justify-end border-t border-border px-4 py-3">
              <Button type="button" size="sm" disabled={!isHttpUrl(urlSource)} onClick={addUrlSource}>
                Add source
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
    </>
  );
}
