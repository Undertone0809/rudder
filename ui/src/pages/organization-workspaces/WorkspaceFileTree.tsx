import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { OrganizationSkillListItem, OrganizationWorkspaceFileEntry, Project, ProjectResourceAttachment } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import {
  Box,
  Boxes,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileAudio2,
  FileCode2,
  FilePlus2,
  Files,
  FileText,
  FileVideo2,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Link2,
  Loader2,
  MoreHorizontal,
  PackageOpen,
  Pencil,
  Plus,
  Trash2,
  Unlink,
  UserRound
} from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { organizationsApi } from "../../api/orgs";
import { AgentIcon } from "../../components/AgentIconPicker";
import { ProjectIcon } from "../../components/ProjectIdentity";
import { WorkspaceLaunchTargetIcon } from "../../components/workspaces/WorkspaceLaunchControls";
import type { DesktopWorkspaceLaunchTarget } from "../../lib/desktop-shell";
import { queryKeys } from "../../lib/queryKeys";
import {
  isWorkspaceAudioFilePath,
  isWorkspaceImageFilePath,
  isWorkspaceTextDocumentFilePath,
  isWorkspaceVideoFilePath,
} from "../../lib/workspace-document-policy";
import { workspaceFileOpenTargets, type WorkspaceFileOpenTarget, type WorkspaceOpenTargetId } from "../../lib/workspace-preferences";
import {
  canCopyWorkspaceEntry,
  canCreateInsideWorkspaceDirectory,
  canDeleteWorkspaceEntry,
  canDropWorkspaceEntryIntoDirectory,
  canMoveWorkspaceEntry,
  canRenameWorkspaceEntry,
  displayWorkspaceEntryLabel,
  getWorkspaceImportDropFiles,
  hasExternalFileDragPayload,
  hasWorkspaceDragPayload,
  isLibrarySkillPackageFolderPath,
  isLibrarySkillsRootPath,
  isProjectLibraryFolderPath,
  isProtectedAgentWorkspaceContainerPath,
  mergeWorkspaceAndVirtualSkillEntries,
  parentWorkspaceDirectoryPath,
  projectResourceEntryPath,
  projectResourceFolderPath,
  WORKSPACE_ENTRY_DND_MIME,
  type ProjectResourceTreeGroup,
  type WorkspaceTreeEntry,
} from "../../lib/workspace-tree-policy";

const WORKSPACE_TREE_ENTRY_SELECTOR = "[data-workspace-entry-path]";

function serializeWorkspaceDragEntry(entry: OrganizationWorkspaceFileEntry) {
  return JSON.stringify({
    path: entry.path,
    isDirectory: entry.isDirectory,
  });
}

function setWorkspaceEntryDragImage(event: DragEvent<HTMLElement>) {
  if (typeof event.dataTransfer.setDragImage !== "function") return;

  const source = event.currentTarget.cloneNode(true);
  if (!(source instanceof HTMLElement)) return;

  source.querySelector("[data-testid^='org-workspaces-entry-more-']")?.remove();
  source.classList.remove("hover:bg-accent/60", "hover:bg-accent/50", "hover:text-foreground");
  source.classList.add("rudder-workspace-tree-drag-image");
  source.removeAttribute("data-workspace-entry-path");
  source.removeAttribute("draggable");

  const rect = event.currentTarget.getBoundingClientRect();
  source.style.position = "fixed";
  source.style.top = "-1000px";
  source.style.left = "-1000px";
  source.style.width = `${Math.min(Math.max(rect.width || 220, 190), 300)}px`;
  source.style.paddingLeft = "10px";
  source.style.opacity = "1";
  source.style.pointerEvents = "none";
  source.style.zIndex = "-1";

  document.body.appendChild(source);
  event.dataTransfer.setDragImage(source, Math.min(event.clientX - rect.left, 26), Math.min(event.clientY - rect.top, 16));
  window.setTimeout(() => source.remove(), 0);
}

export function parseWorkspaceDragEntry(event: DragEvent<HTMLElement>) {
  const payload = event.dataTransfer.getData(WORKSPACE_ENTRY_DND_MIME);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">>;
    if (typeof parsed.path !== "string" || typeof parsed.isDirectory !== "boolean") return null;
    return {
      path: parsed.path,
      isDirectory: parsed.isDirectory,
    };
  } catch {
    return null;
  }
}

export function didDragLeaveCurrentTarget(event: DragEvent<HTMLElement>) {
  const relatedTarget = event.relatedTarget;
  return !(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget);
}

export function focusWorkspaceTreeEntry(entryPath: string | null) {
  if (typeof document === "undefined") return;
  const entry = Array.from(document.querySelectorAll<HTMLElement>(WORKSPACE_TREE_ENTRY_SELECTOR))
    .find((node) => node.dataset.workspaceEntryPath === entryPath);
  if (!entry) return;
  entry.scrollIntoView?.({ block: "center" });
  const button = entry.querySelector<HTMLButtonElement>("button");
  button?.focus({ preventScroll: true });
}

function visibleWorkspaceTreeEntries() {
  if (typeof document === "undefined") return [];
  return Array.from(document.querySelectorAll<HTMLElement>(WORKSPACE_TREE_ENTRY_SELECTOR));
}

function focusWorkspaceTreeEntryByOffset(
  currentPath: string,
  offset: -1 | 1,
  onFocusEntry: (entryPath: string) => void,
) {
  const entries = visibleWorkspaceTreeEntries();
  const currentIndex = entries.findIndex((node) => node.dataset.workspaceEntryPath === currentPath);
  if (currentIndex < 0) return;
  const next = entries[currentIndex + offset];
  const nextPath = next?.dataset.workspaceEntryPath;
  if (!nextPath) return;
  onFocusEntry(nextPath);
  focusWorkspaceTreeEntry(nextPath);
}

function focusWorkspaceParentEntry(
  currentPath: string,
  onFocusEntry: (entryPath: string) => void,
) {
  const parentPath = parentWorkspaceDirectoryPath(currentPath);
  if (!parentPath) return;
  onFocusEntry(parentPath);
  focusWorkspaceTreeEntry(parentPath);
}

function projectResourceKindIcon(kind: ProjectResourceAttachment["resource"]["kind"]) {
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

function ProjectResourcesVirtualTree({
  group,
  selectedResourcePath,
  activeEntryPath,
  onSelectResource,
  onFocusEntry,
  onAddResources,
  onCopyResourceLocator,
  onOpenResource,
  onUnlinkResource,
  unlinkingResourceId,
  depth,
}: {
  group: ProjectResourceTreeGroup;
  selectedResourcePath: string | null;
  activeEntryPath: string | null;
  onSelectResource: (attachmentId: string) => void;
  onFocusEntry: (entryPath: string) => void;
  onAddResources: (project: Project) => void;
  onCopyResourceLocator: (attachment: ProjectResourceAttachment) => void;
  onOpenResource: (attachment: ProjectResourceAttachment) => void;
  onUnlinkResource: (project: Project, attachment: ProjectResourceAttachment) => void;
  unlinkingResourceId: string | null;
  depth: number;
}) {
  const folderPath = projectResourceFolderPath(group.project);
  const [expanded, setExpanded] = useState(
    selectedResourcePath?.startsWith(`${folderPath}/`) ?? false,
  );
  const folderActive = activeEntryPath === folderPath;
  const [folderActionMenuOpen, setFolderActionMenuOpen] = useState(false);

  useEffect(() => {
    if (selectedResourcePath?.startsWith(`${folderPath}/`)) {
      setExpanded(true);
    }
  }, [folderPath, selectedResourcePath]);

  return (
    <ul className="space-y-0.5">
      <li>
        <div
          className={cn(
            "group flex w-full items-center rounded-md pr-1 text-sm text-foreground transition-colors hover:bg-accent/60",
            folderActive && "bg-accent text-foreground",
          )}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          data-workspace-entry-path={folderPath}
          data-testid={`org-workspaces-project-resources-folder-${group.project.id}`}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onFocusEntry(folderPath);
            setFolderActionMenuOpen(true);
          }}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
            onClick={() => {
              onFocusEntry(folderPath);
              setExpanded((value) => !value);
            }}
            onFocus={() => onFocusEntry(folderPath)}
            aria-expanded={expanded}
            aria-selected={folderActive}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium">resources</span>
            <span className="shrink-0 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {group.resources.length}
            </span>
          </button>
          <DropdownMenu open={folderActionMenuOpen} onOpenChange={setFolderActionMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
                aria-label={`More actions for ${group.project.name} resources`}
                data-testid={`org-workspaces-project-resources-more-${group.project.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onFocusEntry(folderPath);
                }}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={6}
              className="w-44"
              onClick={(event) => event.stopPropagation()}
            >
              <DropdownMenuItem onSelect={() => onAddResources(group.project)}>
                <Link2 className="h-3.5 w-3.5" />
                Add resources
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {expanded ? (
          <ul className="space-y-0.5">
            {group.resources.map((attachment) => {
              const entryPath = projectResourceEntryPath(group.project, attachment);
              const isSelected = selectedResourcePath === entryPath;
              const isActive = activeEntryPath === entryPath;
              const Icon = projectResourceKindIcon(attachment.resource.kind);
              const isUnlinking = unlinkingResourceId === attachment.id;
              return (
                <li key={attachment.id}>
                  <div
                    className={cn(
                      "group flex w-full items-center rounded-md pr-1 text-sm transition-colors",
                      isSelected || isActive
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                    style={{ paddingLeft: `${(depth + 1) * 14 + 23}px` }}
                    data-workspace-entry-path={entryPath}
                    data-testid={`org-workspaces-project-resource-${attachment.id}`}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
                      onClick={() => {
                        onFocusEntry(entryPath);
                        onSelectResource(attachment.id);
                      }}
                      onFocus={() => onFocusEntry(entryPath)}
                      aria-selected={isActive || isSelected}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{attachment.resource.name}</span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
                          aria-label={`More actions for ${attachment.resource.name}`}
                          data-testid={`org-workspaces-project-resource-more-${attachment.id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onFocusEntry(entryPath);
                          }}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        sideOffset={6}
                        className="w-48"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <DropdownMenuItem onSelect={() => onOpenResource(attachment)}>
                          <ExternalLink className="h-3.5 w-3.5" />
                          Open resource
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onCopyResourceLocator(attachment)}>
                          <Copy className="h-3.5 w-3.5" />
                          Copy locator
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={isUnlinking}
                          onSelect={() => onUnlinkResource(group.project, attachment)}
                        >
                          {isUnlinking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
                          Unlink resource
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </li>
    </ul>
  );
}

function DirectoryChildren({
  orgId,
  directoryPath,
  organizationSkills,
  selectedFilePath,
  selectedSkillTreePath,
  selectedResourcePath,
  activeEntryPath,
  draggedEntryPath,
  onSelectFile,
  onSelectSkillFile,
  onSelectResource,
  onFocusEntry,
  onDragStartEntry,
  onDragEndEntry,
  onCopyLink,
  onCopyAbsolutePath,
  onOpenEntry,
  onOpenEntryTarget,
  onStartCreateEntry,
  onCopyEntry,
  onStartRename,
  onStartDelete,
  onMoveEntry,
  onImportFiles,
  onAddResources,
  onCopyResourceLocator,
  onOpenResource,
  onUnlinkResource,
  onOpenSkillAddDialog,
  unlinkingResourceId,
  expandedDirectories,
  workspaceLaunchTargets,
  openingWorkspaceTargetId,
  projectResourceGroupsByLibraryPath,
  depth,
}: {
  orgId: string;
  directoryPath: string;
  organizationSkills?: OrganizationSkillListItem[];
  selectedFilePath: string | null;
  selectedSkillTreePath: string | null;
  selectedResourcePath: string | null;
  activeEntryPath: string | null;
  draggedEntryPath: string | null;
  onSelectFile: (filePath: string) => void;
  onSelectSkillFile?: (skillId: string, filePath: string, treePath: string) => void;
  onSelectResource: (attachmentId: string) => void;
  onFocusEntry: (entryPath: string) => void;
  onDragStartEntry: (entryPath: string) => void;
  onDragEndEntry: () => void;
  onCopyLink: (entry: OrganizationWorkspaceFileEntry) => void;
  onCopyAbsolutePath: (entry: OrganizationWorkspaceFileEntry) => void;
  onOpenEntry?: (entry: OrganizationWorkspaceFileEntry) => void;
  onOpenEntryTarget?: (entry: OrganizationWorkspaceFileEntry, target: DesktopWorkspaceLaunchTarget | WorkspaceFileOpenTarget) => void;
  onStartCreateEntry: (entry: OrganizationWorkspaceFileEntry, kind: "file" | "folder") => void;
  onCopyEntry: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartRename: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartDelete: (entry: OrganizationWorkspaceFileEntry) => void;
  onMoveEntry: (entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">, destinationDirectoryPath: string) => void;
  onImportFiles: (files: File[], destinationDirectoryPath: string, unsupportedCount?: number) => void;
  onAddResources: (project: Project) => void;
  onCopyResourceLocator: (attachment: ProjectResourceAttachment) => void;
  onOpenResource: (attachment: ProjectResourceAttachment) => void;
  onUnlinkResource: (project: Project, attachment: ProjectResourceAttachment) => void;
  onOpenSkillAddDialog?: () => void;
  unlinkingResourceId: string | null;
  expandedDirectories: Set<string>;
  workspaceLaunchTargets: DesktopWorkspaceLaunchTarget[];
  openingWorkspaceTargetId: WorkspaceOpenTargetId | null;
  projectResourceGroupsByLibraryPath: Map<string, ProjectResourceTreeGroup>;
  depth: number;
}) {
  const { data } = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(orgId, directoryPath),
    queryFn: () => organizationsApi.listWorkspaceFiles(orgId, directoryPath),
    enabled: !!orgId,
    refetchOnWindowFocus: false,
  });

  const entries = useMemo(
    () => mergeWorkspaceAndVirtualSkillEntries(directoryPath, data?.entries ?? [], organizationSkills),
    [data?.entries, directoryPath, organizationSkills],
  );
  if (entries.length === 0) return null;

  return (
    <ul className="space-y-0.5">
      {entries.map((entry) => (
        <WorkspaceTreeNode
          key={entry.path}
          orgId={orgId}
          entry={entry}
          organizationSkills={organizationSkills}
          selectedFilePath={selectedFilePath}
          selectedSkillTreePath={selectedSkillTreePath}
          selectedResourcePath={selectedResourcePath}
          activeEntryPath={activeEntryPath}
          draggedEntryPath={draggedEntryPath}
          onSelectFile={onSelectFile}
          onSelectSkillFile={onSelectSkillFile}
          onSelectResource={onSelectResource}
          onFocusEntry={onFocusEntry}
          onDragStartEntry={onDragStartEntry}
          onDragEndEntry={onDragEndEntry}
          onCopyLink={onCopyLink}
          onCopyAbsolutePath={onCopyAbsolutePath}
          onOpenEntry={onOpenEntry}
          onOpenEntryTarget={onOpenEntryTarget}
          onStartCreateEntry={onStartCreateEntry}
          onCopyEntry={onCopyEntry}
          onStartRename={onStartRename}
          onStartDelete={onStartDelete}
          onMoveEntry={onMoveEntry}
          onImportFiles={onImportFiles}
          onAddResources={onAddResources}
          onCopyResourceLocator={onCopyResourceLocator}
          onOpenResource={onOpenResource}
          onUnlinkResource={onUnlinkResource}
          onOpenSkillAddDialog={onOpenSkillAddDialog}
          unlinkingResourceId={unlinkingResourceId}
          expandedDirectories={expandedDirectories}
          workspaceLaunchTargets={workspaceLaunchTargets}
          openingWorkspaceTargetId={openingWorkspaceTargetId}
          projectResourceGroupsByLibraryPath={projectResourceGroupsByLibraryPath}
          depth={depth}
        />
      ))}
    </ul>
  );
}

export function WorkspaceTreeNode({
  orgId,
  entry,
  organizationSkills = [],
  selectedFilePath,
  selectedSkillTreePath = null,
  selectedResourcePath,
  activeEntryPath,
  draggedEntryPath,
  onSelectFile,
  onSelectSkillFile,
  onSelectResource,
  onFocusEntry,
  onDragStartEntry,
  onDragEndEntry,
  onCopyLink,
  onCopyAbsolutePath,
  onOpenEntry,
  onOpenEntryTarget,
  onStartCreateEntry,
  onCopyEntry,
  onStartRename,
  onStartDelete,
  onMoveEntry,
  onImportFiles,
  onAddResources,
  onCopyResourceLocator,
  onOpenResource,
  onUnlinkResource,
  onOpenSkillAddDialog,
  unlinkingResourceId,
  expandedDirectories,
  workspaceLaunchTargets,
  openingWorkspaceTargetId,
  projectResourceGroupsByLibraryPath,
  depth = 0,
}: {
  orgId: string;
  entry: WorkspaceTreeEntry;
  organizationSkills?: OrganizationSkillListItem[];
  selectedFilePath: string | null;
  selectedSkillTreePath?: string | null;
  selectedResourcePath: string | null;
  activeEntryPath: string | null;
  draggedEntryPath: string | null;
  onSelectFile: (filePath: string) => void;
  onSelectSkillFile?: (skillId: string, filePath: string, treePath: string) => void;
  onSelectResource: (attachmentId: string) => void;
  onFocusEntry: (entryPath: string) => void;
  onDragStartEntry: (entryPath: string) => void;
  onDragEndEntry: () => void;
  onCopyLink: (entry: OrganizationWorkspaceFileEntry) => void;
  onCopyAbsolutePath: (entry: OrganizationWorkspaceFileEntry) => void;
  onOpenEntry?: (entry: OrganizationWorkspaceFileEntry) => void;
  onOpenEntryTarget?: (entry: OrganizationWorkspaceFileEntry, target: DesktopWorkspaceLaunchTarget | WorkspaceFileOpenTarget) => void;
  onStartCreateEntry: (entry: OrganizationWorkspaceFileEntry, kind: "file" | "folder") => void;
  onCopyEntry: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartRename: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartDelete: (entry: OrganizationWorkspaceFileEntry) => void;
  onMoveEntry: (entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">, destinationDirectoryPath: string) => void;
  onImportFiles: (files: File[], destinationDirectoryPath: string, unsupportedCount?: number) => void;
  onAddResources: (project: Project) => void;
  onCopyResourceLocator: (attachment: ProjectResourceAttachment) => void;
  onOpenResource: (attachment: ProjectResourceAttachment) => void;
  onUnlinkResource: (project: Project, attachment: ProjectResourceAttachment) => void;
  onOpenSkillAddDialog?: () => void;
  unlinkingResourceId: string | null;
  expandedDirectories: Set<string>;
  workspaceLaunchTargets: DesktopWorkspaceLaunchTarget[];
  openingWorkspaceTargetId: WorkspaceOpenTargetId | null;
  projectResourceGroupsByLibraryPath: Map<string, ProjectResourceTreeGroup>;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(expandedDirectories.has(entry.path));
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const primaryLabel = displayWorkspaceEntryLabel(entry);
  const isVirtualSkillEntry = Boolean(entry.virtualSkillId);
  const isAgentWorkspace = entry.entityType === "agent_workspace";
  const isAgentsRoot = entry.path === "agents";
  const isSkillsRoot = isLibrarySkillsRootPath(entry.path);
  const isSkillPackageFolder = isLibrarySkillPackageFolderPath(entry.path);
  const isProjectLibraryFolder = isProjectLibraryFolderPath(entry.path);
  const isProtectedContainer = isProtectedAgentWorkspaceContainerPath(entry.path);
  const projectResourceGroup = projectResourceGroupsByLibraryPath.get(entry.path) ?? null;
  const canCreateInsideDirectory = !isVirtualSkillEntry && entry.isDirectory && canCreateInsideWorkspaceDirectory(entry.path);
  const canCopyEntry = !isVirtualSkillEntry && canCopyWorkspaceEntry(entry);
  const canMoveEntry = !isVirtualSkillEntry && canMoveWorkspaceEntry(entry);
  const canRenameEntry = !isVirtualSkillEntry && canRenameWorkspaceEntry(entry);
  const canDeleteEntry = !isVirtualSkillEntry && canDeleteWorkspaceEntry(entry);
  const canDropIntoDirectory = !isVirtualSkillEntry && entry.isDirectory && canCreateInsideWorkspaceDirectory(entry.path);
  const entryOpenTargets = entry.isDirectory
    ? workspaceLaunchTargets
    : workspaceFileOpenTargets(workspaceLaunchTargets);
  const isActive = activeEntryPath === entry.path
    || selectedSkillTreePath === entry.path
    || (!activeEntryPath && selectedFilePath === entry.path);
  const isDraggingEntry = draggedEntryPath === entry.path;
  const handleOpenActionMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onFocusEntry(entry.path);
    setActionMenuOpen(true);
  };
  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    if (!canMoveEntry) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKSPACE_ENTRY_DND_MIME, serializeWorkspaceDragEntry(entry));
    event.dataTransfer.setData("text/plain", entry.path);
    onDragStartEntry(entry.path);
    setWorkspaceEntryDragImage(event);
  };
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!canDropIntoDirectory) return;
    const hasExternalFiles = hasExternalFileDragPayload(event.dataTransfer);
    if (!hasWorkspaceDragPayload(event.dataTransfer) && !hasExternalFiles) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = hasExternalFiles ? "copy" : "move";
    setDropActive(true);
  };
  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (didDragLeaveCurrentTarget(event)) {
      setDropActive(false);
    }
  };
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!canDropIntoDirectory) return;
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    if (hasExternalFileDragPayload(event.dataTransfer)) {
      const { supported, unsupportedCount } = getWorkspaceImportDropFiles(event.dataTransfer);
      onImportFiles(supported, entry.path, unsupportedCount);
      setExpanded(true);
      return;
    }
    const source = parseWorkspaceDragEntry(event);
    if (!source) return;
    if (!canDropWorkspaceEntryIntoDirectory(source, entry.path)) return;
    onMoveEntry(source, entry.path);
    setExpanded(true);
  };
  const handleKeyboardNavigation = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusWorkspaceTreeEntryByOffset(entry.path, 1, onFocusEntry);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusWorkspaceTreeEntryByOffset(entry.path, -1, onFocusEntry);
      return;
    }
    if (event.key === "ArrowRight" && entry.isDirectory) {
      event.preventDefault();
      onFocusEntry(entry.path);
      if (!expanded) {
        setExpanded(true);
      } else {
        window.requestAnimationFrame(() => focusWorkspaceTreeEntryByOffset(entry.path, 1, onFocusEntry));
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onFocusEntry(entry.path);
      if (entry.isDirectory && expanded) {
        setExpanded(false);
      } else {
        focusWorkspaceParentEntry(entry.path, onFocusEntry);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onFocusEntry(entry.path);
      if (entry.isDirectory) {
        setExpanded((value) => !value);
      } else if (entry.virtualSkillId && entry.virtualSkillFilePath) {
        onSelectSkillFile?.(entry.virtualSkillId, entry.virtualSkillFilePath, entry.path);
      } else {
        onSelectFile(entry.path);
      }
    }
  };

  const actionMenu = (
    <DropdownMenu open={actionMenuOpen} onOpenChange={setActionMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
          aria-label={`More actions for ${primaryLabel}`}
          data-testid={`org-workspaces-entry-more-${entry.path}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-60 whitespace-nowrap will-change-[opacity,transform] data-[state=open]:duration-150 data-[state=open]:ease-out data-[state=closed]:duration-100 data-[state=closed]:ease-in"
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <DropdownMenuItem onSelect={() => onCopyLink(entry)}>
          <Link2 className="h-3.5 w-3.5" />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCopyAbsolutePath(entry)}>
          <Copy className="h-3.5 w-3.5" />
          Copy absolute path
        </DropdownMenuItem>
        {!isProtectedContainer ? (
          <>
            {onOpenEntry || onOpenEntryTarget || canCreateInsideDirectory ? <DropdownMenuSeparator /> : null}
            {onOpenEntry || onOpenEntryTarget ? (
              entryOpenTargets.length > 0 && onOpenEntryTarget ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger
                    className="h-9 rounded-[6px] px-2 text-sm"
                    data-testid={`org-workspaces-entry-open-submenu-${entry.path}`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {entry.isDirectory ? "Open folder" : "Open In"}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    sideOffset={6}
                    className="w-60 whitespace-nowrap p-1"
                  >
                    {entryOpenTargets.map((target) => (
                      <DropdownMenuItem
                        key={target.id}
                        className="h-9 gap-2 rounded-[6px]"
                        disabled={openingWorkspaceTargetId !== null}
                        data-testid={`org-workspaces-entry-open-target-${entry.path}-${target.id}`}
                        onSelect={() => onOpenEntryTarget(entry, target)}
                      >
                        {openingWorkspaceTargetId === target.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <WorkspaceLaunchTargetIcon target={target} />
                        )}
                        <span className="min-w-0 flex-1 truncate">{target.label}</span>
                        <span className="text-[11px] capitalize text-muted-foreground">{target.kind}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : onOpenEntry ? (
                <DropdownMenuItem onSelect={() => onOpenEntry(entry)}>
                  <ExternalLink className="h-3.5 w-3.5" />
                  {entry.isDirectory ? "Open folder" : "Open In"}
                </DropdownMenuItem>
              ) : null
            ) : null}
            {canCreateInsideDirectory ? (
              <>
                {onOpenEntry || onOpenEntryTarget ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={() => onStartCreateEntry(entry, "file")}>
                  <FilePlus2 className="h-3.5 w-3.5" />
                  New file
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onStartCreateEntry(entry, "folder")}>
                  <FolderPlus className="h-3.5 w-3.5" />
                  New folder
                </DropdownMenuItem>
              </>
            ) : null}
            {canCopyEntry || canRenameEntry || canDeleteEntry ? <DropdownMenuSeparator /> : null}
            {canCopyEntry ? (
              <DropdownMenuItem onSelect={() => onCopyEntry(entry)}>
                <Files className="h-3.5 w-3.5" />
                Create copy
              </DropdownMenuItem>
            ) : null}
            {canRenameEntry ? (
              <DropdownMenuItem onSelect={() => onStartRename(entry)}>
                <Pencil className="h-3.5 w-3.5" />
                Rename
              </DropdownMenuItem>
            ) : null}
            {canDeleteEntry ? (
              <DropdownMenuItem variant="destructive" onSelect={() => onStartDelete(entry)}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        {isProtectedContainer && canDeleteEntry ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onStartDelete(entry)}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  useEffect(() => {
    if (expandedDirectories.has(entry.path)) {
      setExpanded(true);
    }
  }, [entry.path, expandedDirectories]);

  if (entry.isDirectory) {
    return (
      <li>
        <div
          className={cn(
            "group flex w-full items-center rounded-md pr-1 text-sm text-foreground transition-[background-color,color,opacity,transform] duration-150",
            isDraggingEntry
              ? "rudder-workspace-tree-entry--dragging text-muted-foreground"
              : "hover:bg-accent/60",
            isActive && !isDraggingEntry && "bg-accent text-foreground",
            dropActive && !isDraggingEntry && "bg-[#2f80ed]/10 ring-1 ring-[#2f80ed]/30",
          )}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          data-workspace-entry-path={entry.path}
          data-dragging-workspace-entry={isDraggingEntry ? "true" : undefined}
          draggable={canMoveEntry}
          onDragStart={handleDragStart}
          onDragEnd={() => {
            setDropActive(false);
            onDragEndEntry();
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onContextMenu={handleOpenActionMenu}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
            onClick={() => {
              onFocusEntry(entry.path);
              setExpanded((value) => !value);
            }}
            onFocus={() => onFocusEntry(entry.path)}
            onKeyDown={handleKeyboardNavigation}
            aria-expanded={expanded}
            aria-selected={isActive}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
            {isAgentWorkspace ? (
              <span
                data-testid="org-workspaces-agent-icon"
                className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground"
              >
                <AgentIcon icon={entry.agentIcon} role={entry.agentRole} className="h-3.5 w-3.5 text-[12px]" />
              </span>
            ) : isAgentsRoot ? (
              <UserRound
                data-testid="org-workspaces-agents-root-icon"
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
            ) : isSkillsRoot ? (
              <Boxes
                data-testid="org-workspaces-skills-root-icon"
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
            ) : isSkillPackageFolder ? (
              <Box
                data-testid="org-workspaces-skill-folder-icon"
                className="h-3.5 w-3.5 shrink-0 text-[#2f80ed]"
              />
            ) : isProjectLibraryFolder ? (
              projectResourceGroup ? (
                <ProjectIcon
                  color={projectResourceGroup.project.color}
                  icon={projectResourceGroup.project.icon}
                  size="xs"
                  testId="org-workspaces-project-icon"
                />
              ) : (
                <PackageOpen
                  data-testid="org-workspaces-project-icon"
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                />
              )
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{primaryLabel}</div>
            </div>
            {isAgentWorkspace ? (
              <span
                aria-hidden="true"
                data-testid="org-workspaces-agent-badge"
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
              >
                Agent
              </span>
            ) : null}
          </button>
          {entry.path === "skills" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
                  aria-label="Add skill to Library"
                  data-testid="org-workspaces-skills-add-button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenSkillAddDialog?.();
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add skill</TooltipContent>
            </Tooltip>
          ) : null}
          {isVirtualSkillEntry ? null : actionMenu}
        </div>
        {expanded ? (
          <>
            <DirectoryChildren
              orgId={orgId}
              directoryPath={entry.path}
              organizationSkills={organizationSkills}
              selectedFilePath={selectedFilePath}
              selectedSkillTreePath={selectedSkillTreePath}
              selectedResourcePath={selectedResourcePath}
              activeEntryPath={activeEntryPath}
              draggedEntryPath={draggedEntryPath}
              onSelectFile={onSelectFile}
              onSelectSkillFile={onSelectSkillFile}
              onSelectResource={onSelectResource}
              onFocusEntry={onFocusEntry}
              onDragStartEntry={onDragStartEntry}
              onDragEndEntry={onDragEndEntry}
              onCopyLink={onCopyLink}
              onCopyAbsolutePath={onCopyAbsolutePath}
              onOpenEntry={onOpenEntry}
              onOpenEntryTarget={onOpenEntryTarget}
              onStartCreateEntry={onStartCreateEntry}
              onCopyEntry={onCopyEntry}
              onStartRename={onStartRename}
              onStartDelete={onStartDelete}
              onMoveEntry={onMoveEntry}
              onImportFiles={onImportFiles}
              onAddResources={onAddResources}
              onCopyResourceLocator={onCopyResourceLocator}
              onOpenResource={onOpenResource}
              onUnlinkResource={onUnlinkResource}
              onOpenSkillAddDialog={onOpenSkillAddDialog}
              unlinkingResourceId={unlinkingResourceId}
              expandedDirectories={expandedDirectories}
              workspaceLaunchTargets={workspaceLaunchTargets}
              openingWorkspaceTargetId={openingWorkspaceTargetId}
              projectResourceGroupsByLibraryPath={projectResourceGroupsByLibraryPath}
              depth={depth + 1}
            />
            {projectResourceGroup ? (
              <ProjectResourcesVirtualTree
                group={projectResourceGroup}
                selectedResourcePath={selectedResourcePath}
                activeEntryPath={activeEntryPath}
                onSelectResource={onSelectResource}
                onFocusEntry={onFocusEntry}
                onAddResources={onAddResources}
                onCopyResourceLocator={onCopyResourceLocator}
                onOpenResource={onOpenResource}
                onUnlinkResource={onUnlinkResource}
                unlinkingResourceId={unlinkingResourceId}
                depth={depth + 1}
              />
            ) : null}
          </>
        ) : null}
      </li>
    );
  }

  const isSelected = selectedFilePath === entry.path || selectedSkillTreePath === entry.path;
  const FileIcon = isWorkspaceImageFilePath(entry.path)
    ? ImageIcon
    : isWorkspaceVideoFilePath(entry.path)
      ? FileVideo2
      : isWorkspaceAudioFilePath(entry.path)
        ? FileAudio2
        : isWorkspaceTextDocumentFilePath(entry.path)
          ? FileText
          : FileCode2;
  return (
    <li>
      <div
        className={cn(
          "group flex w-full items-center rounded-md pr-1 text-sm transition-[background-color,color,opacity,transform] duration-150",
          isDraggingEntry
            ? "rudder-workspace-tree-entry--dragging text-muted-foreground"
            : isSelected || isActive
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
        style={{ paddingLeft: `${depth * 14 + 23}px` }}
        data-workspace-entry-path={entry.path}
        data-dragging-workspace-entry={isDraggingEntry ? "true" : undefined}
        draggable={canMoveEntry}
        onDragStart={handleDragStart}
        onDragEnd={() => {
          setDropActive(false);
          onDragEndEntry();
        }}
        onContextMenu={handleOpenActionMenu}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
          onClick={() => {
            onFocusEntry(entry.path);
            if (entry.virtualSkillId && entry.virtualSkillFilePath) {
              onSelectSkillFile?.(entry.virtualSkillId, entry.virtualSkillFilePath, entry.path);
            } else {
              onSelectFile(entry.path);
            }
          }}
          onFocus={() => onFocusEntry(entry.path)}
          onKeyDown={handleKeyboardNavigation}
          aria-selected={isActive || isSelected}
        >
          <FileIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{primaryLabel}</span>
        </button>
        {isVirtualSkillEntry ? null : actionMenu}
      </div>
    </li>
  );
}
