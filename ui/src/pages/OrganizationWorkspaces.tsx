import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNavigate, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import {
  type OrganizationSkillFileDetail,
  type OrganizationWorkspaceFileDetail,
  type OrganizationWorkspaceFileEntry,
  type Project,
  type ProjectResourceAttachment,
  type WorkspaceWebPreviewNetworkMode
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
  MoreHorizontal,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { assetsApi } from "../api/assets";
import { organizationSkillsApi } from "../api/organizationSkills";
import { organizationsApi } from "../api/orgs";
import { projectsApi } from "../api/projects";
import { EmptyState } from "../components/EmptyState";
import { InspectableImage } from "../components/InspectableImage";
import { IssueDetailFind } from "../components/IssueDetailFind";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor, type InlineTokenClickEvent, type MarkdownEditorRef, type MentionOption } from "../components/MarkdownEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { getWorkspaceCodeLanguageLabel, isWorkspaceCodeFilePath, WorkspaceCodeEditor } from "../components/WorkspaceCodeEditor";
import { WorkspaceHtmlPreview, WorkspaceHtmlPreviewToolbar } from "../components/WorkspaceHtmlPreview";
import { WorkspaceLibraryBinaryPreview } from "../components/WorkspaceMediaPreview";
import {
  UnsupportedWorkspaceFileLauncher,
  WorkspaceLaunchMenu,
  WorkspaceLaunchTargetIcon,
} from "../components/workspaces/WorkspaceLaunchControls";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { useViewedOrganization } from "../hooks/useViewedOrganization";
import { readDesktopShell, type DesktopIdeTarget, type DesktopWorkspaceLaunchTarget } from "../lib/desktop-shell";
import { extractDocumentOutline, type DocumentOutlineItem } from "../lib/document-outline";
import type { AtomicInlineTokenElement } from "../lib/inline-token-dom";
import { libraryCopy } from "../lib/library-copy";
import { getCachedLibraryEntryMetadata } from "../lib/library-entry-cache";
import { mentionChipNavigationPath, parseMentionChipHref } from "../lib/mention-chips";
import { queryKeys } from "../lib/queryKeys";
import { normalizeWorkspaceCsvRows, parseWorkspaceCsvContent } from "../lib/workspace-csv";
import {
  countWorkspaceDocumentWords,
  displayWorkspaceDocumentKind,
  formatWorkspaceWordCount,
  isWorkspaceCsvContentType,
  isWorkspaceCsvFilePath,
  isWorkspaceMarkdownFilePath,
  joinYamlFrontmatter,
  splitYamlFrontmatter,
  workspaceImageAssetNamespace
} from "../lib/workspace-document-policy";
import {
  isWorkspaceHtmlContentType,
  isWorkspaceHtmlFilePath,
} from "../lib/workspace-html-preview";
import {
  directoryAndParentDirectories,
  normalizeRequestedPath,
  parentDirectories,
} from "../lib/workspace-path-policy";
import {
  appendWorkspaceOpenFilePath,
  isWorkspaceCloseCurrentTabShortcut,
  isWorkspaceFileOpenTarget,
  normalizeWorkspaceOpenFilePaths,
  readStoredWorkspaceLaunchTargetId,
  readStoredWorkspaceOpenFileTabState,
  readStoredWorkspaceUnsupportedFileLaunchTargetId,
  resolveWorkspaceUnsupportedFileLaunchTarget,
  workspaceFileOpenTargets,
  workspaceLaunchMenuOpeningId,
  workspaceUnsupportedFileLaunchTargets,
  writeStoredWorkspaceLaunchTargetId,
  writeStoredWorkspaceOpenFileTabState,
  writeStoredWorkspaceUnsupportedFileLaunchTargetId,
  type WorkspaceFileOpenTarget,
  type WorkspaceOpenTargetId,
  type WorkspaceUnsupportedFileLaunchTarget
} from "../lib/workspace-preferences";
import {
  applyMovedWorkspacePath,
  applyOrganizationSkillBreadcrumbLabels,
  buildWorkspaceEntryLinkMarkdown,
  buildWorkspaceFileLinkMarkdown,
  canCopyWorkspaceEntry,
  canCreateInsideWorkspaceDirectory,
  canDeleteWorkspaceEntry,
  canDropWorkspaceEntryIntoDirectory,
  canRenameWorkspaceEntry,
  displayWorkspaceFileTabLabel,
  findProjectResourceSelection,
  getWorkspaceImportDropFiles,
  hasExternalFileDragPayload,
  hasWorkspaceDragPayload,
  isDraggingOverWorkspaceTreeEntry,
  isLegacyAgentHeartbeatInstructionPath,
  isValidWorkspaceEntryName,
  isWorkspaceBackedOrganizationSkill,
  joinWorkspaceEntryPath,
  joinWorkspacePath,
  mergeWorkspaceAndVirtualSkillEntries,
  organizationSkillFileTreePath,
  parentWorkspaceDirectoryPath,
  projectResourceFolderPath,
  workspacePathBreadcrumb
} from "../lib/workspace-tree-policy";
import {
  copyWorkspaceText,
  createWorkspaceFilesFromDroppedFiles,
  isHttpUrl,
  requestWorkspaceDraftFlush,
  resolveResourceOpenPath,
  updateSelectedDirectory,
  updateSelectedPath,
  updateSelectedResource,
  updateSelectedSkillFile,
  useProjectResourceTreeGroups,
  WORKSPACE_FLUSH_DRAFT_EVENT,
} from "./organization-workspaces/organizationWorkspaceCapabilities";
import { ProjectResourceDetailPanel } from "./organization-workspaces/ProjectResourceDetailPanel";
import { SkillLibraryAddDialog } from "./organization-workspaces/SkillLibraryAddDialog";
import { useWorkspaceFileSaveQueue } from "./organization-workspaces/useWorkspaceFileSaveQueue";
import { CsvWorkspaceEditor, LegacyHeartbeatInstructionsDialog } from "./organization-workspaces/WorkspaceDocumentEditors";
import {
  didDragLeaveCurrentTarget,
  focusWorkspaceTreeEntry,
  parseWorkspaceDragEntry,
  WorkspaceTreeNode,
} from "./organization-workspaces/WorkspaceFileTree";
import { WorkspaceTabContextMenu } from "./organization-workspaces/WorkspaceTabContextMenu";

export { OrganizationWorkspaceFilesSidebar } from "./organization-workspaces/OrganizationWorkspaceFilesSidebar";

export { WorkspaceLaunchTargetIcon };

const MOBILE_BREAKPOINT = 768;
const WORKSPACE_TREE_ENTRY_SELECTOR = "[data-workspace-entry-path]";
const WORKSPACE_TAB_CONTEXT_MENU_WIDTH = 220;
const WORKSPACE_TAB_CONTEXT_MENU_MAX_HEIGHT = 256;
const SKILL_INSTALL_CHAT_PREFILL = [
  "Install or import a skill into this Rudder organization.",
  "",
  "Source or command:",
  "<paste a GitHub URL, local path, or skills.sh command here>",
  "",
  "After importing, verify it appears in Library / skills and explain whether it is editable or read-only.",
].join("\n");
const WORKSPACE_TAB_DND_MIME = "application/x-rudder-workspace-tab";

function clampWorkspaceTabContextMenuPosition(left: number, top: number) {
  if (typeof window === "undefined") return { left, top };
  return {
    left: Math.min(left, Math.max(8, window.innerWidth - WORKSPACE_TAB_CONTEXT_MENU_WIDTH - 8)),
    top: Math.min(top, Math.max(8, window.innerHeight - WORKSPACE_TAB_CONTEXT_MENU_MAX_HEIGHT - 8)),
  };
}

type OrganizationWorkspaceBrowserProps = { breadcrumbLabel?: string; emptyMessage?: string; editorTitle?: string; noSelectionMessage?: ReactNode };

export function OrganizationWorkspaceBrowser(props: OrganizationWorkspaceBrowserProps) {
  const { viewedOrganizationId } = useViewedOrganization();
  return <OrganizationWorkspaceBrowserForOrganization key={viewedOrganizationId ?? "__none__"} {...props} />;
}

function OrganizationWorkspaceBrowserForOrganization({
  breadcrumbLabel = "Workspaces",
  emptyMessage = "Select an organization to browse its shared workspace.",
  editorTitle = "Editor",
  noSelectionMessage = (
    <>
      Choose a file from the workspace tree to edit it. Agent and organization skill cards can jump here
      directly into the target <span className="font-mono">SKILL.md</span>, and any shared file already in
      this workspace can be edited here.
    </>
  ),
}: OrganizationWorkspaceBrowserProps) {
  const { setBreadcrumbs, setHeaderActions } = useBreadcrumbs();
  const { locale } = useI18n();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { viewedOrganization, viewedOrganizationId } = useViewedOrganization();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedDocumentId = normalizeRequestedPath(searchParams.get("doc"));
  const requestedEntryId = normalizeRequestedPath(searchParams.get("entry"));
  const requestedSkillId = requestedEntryId || requestedDocumentId ? null : normalizeRequestedPath(searchParams.get("skill"));
  const requestedSkillFilePath = requestedSkillId ? (normalizeRequestedPath(searchParams.get("skillFile")) ?? "SKILL.md") : null;
  const requestedEntryPathHint = requestedEntryId ? normalizeRequestedPath(searchParams.get("path")) : null;
  const requestedFilePath = requestedEntryId || requestedDocumentId || requestedSkillId ? null : normalizeRequestedPath(searchParams.get("path"));
  const requestedResourceAttachmentId = requestedEntryId || requestedDocumentId || requestedSkillId ? null : normalizeRequestedPath(searchParams.get("resource"));
  const requestedDirectoryPath = requestedEntryId || requestedDocumentId || requestedSkillId ? null : normalizeRequestedPath(searchParams.get("directory"));
  const cachedRequestedEntryPath = normalizeRequestedPath(
    getCachedLibraryEntryMetadata(viewedOrganizationId, requestedEntryId)?.currentPath ?? null,
  );
  const fastRequestedEntryPath = cachedRequestedEntryPath ?? requestedEntryPathHint;
  const initialOpenFileTabState = useMemo(
    () => readStoredWorkspaceOpenFileTabState(viewedOrganizationId),
    [viewedOrganizationId],
  );
  const initialSelectedFilePath = requestedDocumentId || requestedResourceAttachmentId || requestedDirectoryPath
    || requestedSkillId
    ? null
    : fastRequestedEntryPath ?? requestedFilePath ?? initialOpenFileTabState.selectedFilePath;
  const initialSafeSelectedFilePath = isLegacyAgentHeartbeatInstructionPath(initialSelectedFilePath)
    ? null
    : initialSelectedFilePath;
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(initialSafeSelectedFilePath);
  const [htmlFileMode, setHtmlFileMode] = useState<"preview" | "source">("preview");
  const initialHtmlPreviewIdentity = `${viewedOrganizationId ?? ""}:${initialSafeSelectedFilePath ?? ""}`;
  const [htmlNetworkSelection, setHtmlNetworkSelection] = useState<{
    identity: string;
    mode: WorkspaceWebPreviewNetworkMode;
  }>({ identity: initialHtmlPreviewIdentity, mode: "connected" });
  const [csvFileMode, setCsvFileMode] = useState<"table" | "source">("table");
  const [showHiddenMarkdownSections, setShowHiddenMarkdownSections] = useState(false);
  const [markdownOutlineCollapsed, setMarkdownOutlineCollapsed] = useState(false);
  const [openFilePaths, setOpenFilePaths] = useState<string[]>(
    () => normalizeWorkspaceOpenFilePaths([...initialOpenFileTabState.openFilePaths, initialSafeSelectedFilePath])
      .filter((filePath) => !isLegacyAgentHeartbeatInstructionPath(filePath)),
  );
  const [tabContextMenu, setTabContextMenu] = useState<{
    filePath: string;
    left: number;
    top: number;
  } | null>(null);
  const [draggedTabPath, setDraggedTabPath] = useState<string | null>(null);
  const [tabDropPreview, setTabDropPreview] = useState<{
    targetPath: string;
    position: "before" | "after";
  } | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [draftFilePath, setDraftFilePath] = useState<string | null>(null);
  const selectedFilePathRef = useRef<string | null>(selectedFilePath);
  const [availableIdes, setAvailableIdes] = useState<DesktopIdeTarget[]>([]);
  const [workspaceLaunchTargets, setWorkspaceLaunchTargets] = useState<DesktopWorkspaceLaunchTarget[]>([]);
  const [lastWorkspaceLaunchTargetId, setLastWorkspaceLaunchTargetId] = useState<
    DesktopWorkspaceLaunchTarget["id"] | null
  >(() => readStoredWorkspaceLaunchTargetId());
  const [openingWorkspaceTargetId, setOpeningWorkspaceTargetId] = useState<
    WorkspaceOpenTargetId | null
  >(null);
  const [lastUnsupportedFileLaunchTargetId, setLastUnsupportedFileLaunchTargetId] = useState<
    WorkspaceOpenTargetId | null
  >(() => readStoredWorkspaceUnsupportedFileLaunchTargetId());
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < MOBILE_BREAKPOINT : false,
  );
  const [renameTarget, setRenameTarget] = useState<OrganizationWorkspaceFileEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<OrganizationWorkspaceFileEntry | null>(null);
  const [skillAddDialogOpen, setSkillAddDialogOpen] = useState(false);
  const [legacyHeartbeatDialogPath, setLegacyHeartbeatDialogPath] = useState<string | null>(
    isLegacyAgentHeartbeatInstructionPath(requestedFilePath) ? requestedFilePath : null,
  );
  const [rootDropActive, setRootDropActive] = useState(false);
  const [draggedEntryPath, setDraggedEntryPath] = useState<string | null>(null);
  const [activeEntryPath, setActiveEntryPath] = useState<string | null>(
    fastRequestedEntryPath ?? requestedFilePath ?? requestedDirectoryPath,
  );
  const [createTarget, setCreateTarget] = useState<{
    parent: OrganizationWorkspaceFileEntry;
    kind: "file" | "folder";
  } | null>(null);
  const [createDraft, setCreateDraft] = useState("");
  const draftStateRef = useRef<{
    draftContent: string;
    draftFilePath: string | null;
  }>({ draftContent: "", draftFilePath: null });
  const syncedFileRef = useRef<{ filePath: string | null; content: string }>({ filePath: null, content: "" });
  const saveWorkspaceFileQueueRef = useRef<ReturnType<typeof useWorkspaceFileSaveQueue>["queue"] | null>(null);
  const editorScrollElementRef = useRef<HTMLElement | null>(null);
  const libraryFindRootRef = useRef<HTMLDivElement | null>(null);
  const markdownEditorRef = useRef<MarkdownEditorRef | null>(null);
  const openFileTabScrollerElementRef = useRef<HTMLDivElement | null>(null);
  const openFileTabElementsRef = useRef(new Map<string, HTMLDivElement>());
  const openFilePathsRef = useRef<string[]>(openFilePaths);
  const restoredOpenTabsOrgRef = useRef<string | null>(null);
  const allowDefaultFileOpenRef = useRef(true);
  const filesScrollRef = useScrollbarActivityRef("org-workspaces:files");
  const editorScrollRef = useScrollbarActivityRef(
    selectedFilePath ? `org-workspaces:editor:${selectedFilePath}` : "org-workspaces:editor",
  );
  const openFileTabsScrollerActivityRef = useScrollbarActivityRef("org-workspaces:editor-tabs");
  const setEditorScrollElementRef = useCallback((element: HTMLElement | null) => {
    editorScrollElementRef.current = element;
    editorScrollRef(element);
  }, [editorScrollRef]);
  const setOpenFileTabsScrollerRef = useCallback((element: HTMLDivElement | null) => {
    openFileTabScrollerElementRef.current = element;
    openFileTabsScrollerActivityRef(element);
  }, [openFileTabsScrollerActivityRef]);
  const setOpenFileTabElementRef = useCallback((filePath: string) => (element: HTMLDivElement | null) => {
    if (element) openFileTabElementsRef.current.set(filePath, element);
    else openFileTabElementsRef.current.delete(filePath);
  }, []);
  selectedFilePathRef.current = selectedFilePath;
  openFilePathsRef.current = openFilePaths;

  useEffect(() => {
    setHtmlFileMode("preview");
    setHtmlNetworkSelection({
      identity: `${viewedOrganizationId ?? ""}:${selectedFilePath ?? ""}`,
      mode: "connected",
    });
    setCsvFileMode("table");
  }, [selectedFilePath, viewedOrganizationId]);

  useEffect(() => {
    const clearRootDropState = () => {
      setRootDropActive(false);
      setDraggedEntryPath(null);
    };
    window.addEventListener("dragend", clearRootDropState);
    window.addEventListener("drop", clearRootDropState, true);
    return () => {
      window.removeEventListener("dragend", clearRootDropState);
      window.removeEventListener("drop", clearRootDropState, true);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handleChange = (event: MediaQueryListEvent) => setIsMobileViewport(event.matches);
    setIsMobileViewport(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const flushCurrentDraft = useCallback(() => {
    const { draftContent: currentDraftContent, draftFilePath: currentDraftFilePath } = draftStateRef.current;
    if (!currentDraftFilePath) return;
    const syncedFile = syncedFileRef.current;
    if (syncedFile.filePath !== currentDraftFilePath || syncedFile.content === currentDraftContent) return;
    saveWorkspaceFileQueueRef.current?.retry(
      currentDraftFilePath,
      currentDraftContent,
      syncedFile.content,
    );
  }, []);

  const openWorkspaceFileTab = useCallback((filePath: string) => {
    setOpenFilePaths((current) => appendWorkspaceOpenFilePath(current, filePath));
  }, []);

  const handleCloseFileTab = useCallback((filePath: string) => {
    flushCurrentDraft();
    setOpenFilePaths((current) => {
      const next = current.filter((candidate) => candidate !== filePath);
      if (selectedFilePath === filePath) {
        const closedIndex = current.indexOf(filePath);
        const nextSelectedPath = next[Math.max(0, closedIndex - 1)] ?? next[0] ?? null;
        if (!nextSelectedPath) allowDefaultFileOpenRef.current = false;
        setSelectedFilePath(nextSelectedPath);
        setDraftFilePath(null);
        updateSelectedPath(searchParams, setSearchParams, nextSelectedPath);
      }
      return next;
    });
  }, [flushCurrentDraft, searchParams, selectedFilePath, setSearchParams]);

  useEffect(() => {
    setBreadcrumbs([{ label: breadcrumbLabel }]);
  }, [breadcrumbLabel, setBreadcrumbs]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell) {
      setAvailableIdes([]);
      setWorkspaceLaunchTargets([]);
      return;
    }

    let cancelled = false;
    if (typeof desktopShell.listAvailableIdes === "function") {
      desktopShell.listAvailableIdes()
        .then((targets) => {
          if (!cancelled) setAvailableIdes(targets);
        })
        .catch(() => {
          if (!cancelled) setAvailableIdes([]);
        });
    } else {
      setAvailableIdes([]);
    }
    if (typeof desktopShell.listWorkspaceLaunchTargets === "function") {
      desktopShell.listWorkspaceLaunchTargets()
        .then((targets) => {
          if (!cancelled) setWorkspaceLaunchTargets(targets);
        })
        .catch(() => {
          if (!cancelled) setWorkspaceLaunchTargets([]);
        });
    } else {
      setWorkspaceLaunchTargets([]);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const rootQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(viewedOrganizationId ?? "__none__", ""),
    queryFn: () => organizationsApi.listWorkspaceFiles(viewedOrganizationId!, ""),
    enabled: !!viewedOrganizationId && !requestedDocumentId,
    refetchOnWindowFocus: false,
  });
  const legacyDocumentQuery = useQuery({
    queryKey: queryKeys.organizations.libraryDocument(viewedOrganizationId ?? "__none__", requestedDocumentId ?? ""),
    queryFn: () => organizationsApi.getLibraryDocument(viewedOrganizationId!, requestedDocumentId!),
    enabled: !!viewedOrganizationId && !!requestedDocumentId,
    refetchOnWindowFocus: false,
  });
  const libraryEntryQuery = useQuery({
    queryKey: queryKeys.organizations.libraryEntry(viewedOrganizationId ?? "__none__", requestedEntryId ?? ""),
    queryFn: () => organizationsApi.getLibraryEntry(viewedOrganizationId!, requestedEntryId!),
    enabled: !!viewedOrganizationId && !!requestedEntryId && !requestedDocumentId,
    refetchOnWindowFocus: false,
  });
  const organizationSkillsQuery = useQuery({
    queryKey: queryKeys.organizationSkills.list(viewedOrganizationId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(viewedOrganizationId!),
    enabled: !!viewedOrganizationId && !requestedDocumentId,
    refetchOnWindowFocus: false,
  });
  const organizationSkills = organizationSkillsQuery.data ?? [];
  const selectedOrganizationSkill = organizationSkills.find((skill) => skill.id === requestedSkillId) ?? null;
  const selectedVirtualOrganizationSkill = selectedOrganizationSkill && !isWorkspaceBackedOrganizationSkill(selectedOrganizationSkill)
    ? selectedOrganizationSkill
    : null;
  const selectedSkillTreePath = selectedVirtualOrganizationSkill && requestedSkillFilePath
    ? organizationSkillFileTreePath(selectedVirtualOrganizationSkill, requestedSkillFilePath)
    : null;
  const requestedEntryPath = normalizeRequestedPath(
    libraryEntryQuery.data?.status === "active"
      ? libraryEntryQuery.data.currentPath
      : fastRequestedEntryPath,
  );
  const projectResourceTree = useProjectResourceTreeGroups(viewedOrganizationId);
  const selectedProjectResource = useMemo(
    () => findProjectResourceSelection(projectResourceTree.projects, requestedResourceAttachmentId),
    [projectResourceTree.projects, requestedResourceAttachmentId],
  );
  const selectedResourcePath = selectedProjectResource?.path ?? null;

  useEffect(() => {
    if (requestedDocumentId) {
      setActiveEntryPath(null);
      return;
    }
    if (requestedSkillId && selectedOrganizationSkill && isWorkspaceBackedOrganizationSkill(selectedOrganizationSkill)) {
      const editablePath = normalizeRequestedPath(selectedOrganizationSkill.workspaceEditPath);
      if (editablePath) {
        updateSelectedPath(searchParams, setSearchParams, editablePath);
      }
      return;
    }
    if (requestedSkillId) {
      setSelectedFilePath(null);
      setDraftFilePath(null);
      setActiveEntryPath(selectedSkillTreePath);
      return;
    }
    if (requestedEntryId) {
      if (requestedEntryPath) {
        setSelectedFilePath(requestedEntryPath);
        setActiveEntryPath(requestedEntryPath);
      }
      if (libraryEntryQuery.data?.status === "active" && libraryEntryQuery.data.currentPath) {
        updateSelectedPath(searchParams, setSearchParams, libraryEntryQuery.data.currentPath);
      } else if (!requestedEntryPath) {
        setActiveEntryPath(null);
      }
      return;
    }
    if (selectedFilePath) setActiveEntryPath(selectedFilePath);
    else if (selectedSkillTreePath) setActiveEntryPath(selectedSkillTreePath);
    else if (selectedResourcePath) setActiveEntryPath(selectedResourcePath);
    else if (requestedDirectoryPath) setActiveEntryPath(requestedDirectoryPath);
  }, [libraryEntryQuery.data?.currentPath, requestedDirectoryPath, requestedDocumentId, requestedEntryId, requestedEntryPath, requestedSkillId, searchParams, selectedFilePath, selectedOrganizationSkill, selectedResourcePath, selectedSkillTreePath, setSearchParams]);
  const agentWorkspaceEntriesQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(viewedOrganizationId ?? "__none__", "agents"),
    queryFn: () => organizationsApi.listWorkspaceFiles(viewedOrganizationId!, "agents"),
    enabled: !!viewedOrganizationId,
    refetchOnWindowFocus: false,
  });
  const agentWorkspaceEntryByName = useMemo(() => new Map(
    (agentWorkspaceEntriesQuery.data?.entries ?? [])
      .filter((entry) => entry.entityType === "agent_workspace")
      .map((entry) => [entry.name, entry] as const),
  ), [agentWorkspaceEntriesQuery.data?.entries]);
  const agentWorkspaceMentionOptions = useMemo<MentionOption[]>(
    () => (agentWorkspaceEntriesQuery.data?.entries ?? [])
      .filter((entry) => entry.entityType === "agent_workspace" && entry.agentId)
      .map((entry) => ({
        id: `agent:${entry.agentId}`,
        name: entry.displayLabel ?? entry.name,
        kind: "agent",
        agentId: entry.agentId!,
        agentIcon: entry.agentIcon ?? null,
        agentRole: entry.agentRole ?? null,
      })),
    [agentWorkspaceEntriesQuery.data?.entries],
  );

  const fileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFile(viewedOrganizationId ?? "__none__", selectedFilePath ?? ""),
    queryFn: () => organizationsApi.readWorkspaceFile(viewedOrganizationId!, selectedFilePath!),
    enabled: !!viewedOrganizationId && !!selectedFilePath,
    refetchOnWindowFocus: false,
  });
  const virtualSkillFileQuery = useQuery({
    queryKey: queryKeys.organizationSkills.file(
      viewedOrganizationId ?? "__none__",
      requestedSkillId ?? "__none__",
      requestedSkillFilePath ?? "SKILL.md",
    ),
    queryFn: () => organizationSkillsApi.file(viewedOrganizationId!, requestedSkillId!, requestedSkillFilePath ?? "SKILL.md"),
    enabled: !!viewedOrganizationId && !!requestedSkillId && !!selectedVirtualOrganizationSkill,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    draftStateRef.current = { draftContent, draftFilePath };
  }, [draftContent, draftFilePath]);

  useEffect(() => {
    flushCurrentDraft();
    if (requestedDocumentId) {
      setSelectedFilePath(null);
      setDraftFilePath(null);
      return;
    }
    if (requestedEntryId) {
      setSelectedFilePath(null);
      setDraftFilePath(null);
      return;
    }
    if (requestedSkillId) {
      setSelectedFilePath(null);
      setDraftFilePath(null);
      return;
    }
    if (requestedResourceAttachmentId) {
      setSelectedFilePath(null);
      setDraftFilePath(null);
      return;
    }
    if (requestedFilePath) {
      if (isLegacyAgentHeartbeatInstructionPath(requestedFilePath)) {
        setLegacyHeartbeatDialogPath(requestedFilePath);
        setSelectedFilePath(null);
        setDraftFilePath(null);
        setActiveEntryPath(requestedFilePath);
        return;
      }
      setSelectedFilePath(requestedFilePath);
      openWorkspaceFileTab(requestedFilePath);
      return;
    }
    if (requestedDirectoryPath) {
      setSelectedFilePath(null);
      setDraftFilePath(null);
      setActiveEntryPath(requestedDirectoryPath);
    }
  }, [
    flushCurrentDraft,
    openWorkspaceFileTab,
    requestedDirectoryPath,
    requestedDocumentId,
    requestedEntryId,
    requestedFilePath,
    requestedResourceAttachmentId,
    requestedSkillId,
    viewedOrganizationId,
  ]);

  useEffect(() => {
    if (!viewedOrganizationId) return;
    if (restoredOpenTabsOrgRef.current !== viewedOrganizationId) return;
    if (requestedDocumentId || requestedEntryId || requestedSkillId || requestedResourceAttachmentId || requestedDirectoryPath) return;
    writeStoredWorkspaceOpenFileTabState(viewedOrganizationId, openFilePaths, selectedFilePath);
  }, [openFilePaths, requestedDirectoryPath, requestedDocumentId, requestedEntryId, requestedResourceAttachmentId, requestedSkillId, selectedFilePath, viewedOrganizationId]);

  useEffect(() => {
    if (!viewedOrganizationId || restoredOpenTabsOrgRef.current === viewedOrganizationId) return;
    restoredOpenTabsOrgRef.current = viewedOrganizationId;
    allowDefaultFileOpenRef.current = true;
    const storedTabState = readStoredWorkspaceOpenFileTabState(viewedOrganizationId);

    if (requestedDocumentId || requestedSkillId || (requestedEntryId && !requestedEntryPath)) {
      setOpenFilePaths([]);
      setSelectedFilePath(null);
      setDraftFilePath(null);
      setActiveEntryPath(null);
      return;
    }

    const requestedWorkspaceFilePath = requestedEntryPath ?? requestedFilePath;
    const nextOpenFilePaths = requestedWorkspaceFilePath
      ? normalizeWorkspaceOpenFilePaths([...storedTabState.openFilePaths, requestedWorkspaceFilePath])
      : storedTabState.openFilePaths;
    const safeOpenFilePaths = nextOpenFilePaths.filter((filePath) => !isLegacyAgentHeartbeatInstructionPath(filePath));
    setOpenFilePaths(safeOpenFilePaths);

    if (requestedResourceAttachmentId) {
      setSelectedFilePath(null);
      setDraftFilePath(null);
      return;
    }

    if (requestedWorkspaceFilePath) {
      if (isLegacyAgentHeartbeatInstructionPath(requestedWorkspaceFilePath)) {
        setLegacyHeartbeatDialogPath(requestedWorkspaceFilePath);
        setSelectedFilePath(null);
        setDraftFilePath(null);
        setActiveEntryPath(requestedWorkspaceFilePath);
        return;
      }
      setSelectedFilePath(requestedWorkspaceFilePath);
      setActiveEntryPath(requestedWorkspaceFilePath);
      return;
    }

    if (requestedDirectoryPath) {
      setSelectedFilePath(null);
      setDraftFilePath(null);
      setActiveEntryPath(requestedDirectoryPath);
      return;
    }

    const restoredFilePath = (
      isLegacyAgentHeartbeatInstructionPath(storedTabState.selectedFilePath)
        ? null
        : storedTabState.selectedFilePath
    ) ?? safeOpenFilePaths[0] ?? null;
    setSelectedFilePath(restoredFilePath);
    setDraftFilePath(null);
    setActiveEntryPath(restoredFilePath);
    if (restoredFilePath) {
      updateSelectedPath(searchParams, setSearchParams, restoredFilePath);
    }
  }, [
    requestedDirectoryPath,
    requestedDocumentId,
    requestedEntryId,
    requestedEntryPath,
    requestedFilePath,
    requestedResourceAttachmentId,
    requestedSkillId,
    searchParams,
    setSearchParams,
    viewedOrganizationId,
  ]);

  useEffect(() => {
    if (requestedDocumentId) return;
    if (requestedEntryId) return;
    if (requestedSkillId) return;
    if (selectedFilePath) return;
    if (requestedResourceAttachmentId) return;
    if (requestedDirectoryPath) return;
    if (openFilePaths.length > 0) return;
    if (!allowDefaultFileOpenRef.current) return;
    const preferredFile = rootQuery.data?.entries.find((entry) => !entry.isDirectory);
    if (preferredFile) {
      setSelectedFilePath(preferredFile.path);
      openWorkspaceFileTab(preferredFile.path);
      updateSelectedPath(searchParams, setSearchParams, preferredFile.path);
    }
  }, [
    openWorkspaceFileTab,
    requestedDirectoryPath,
    requestedDocumentId,
    requestedEntryId,
    requestedResourceAttachmentId,
    requestedSkillId,
    openFilePaths.length,
    rootQuery.data?.entries,
    searchParams,
    selectedFilePath,
    setSearchParams,
  ]);

  useEffect(() => {
    if (!selectedFilePath) {
      setDraftContent("");
      setDraftFilePath(null);
      return;
    }
    if (!fileQuery.data || fileQuery.data.filePath !== selectedFilePath) return;
    const serverContent = fileQuery.data.content ?? "";
    const syncedFile = syncedFileRef.current;
    const hasLocalDirtyDraft =
      draftFilePath === selectedFilePath
      && syncedFile.filePath === selectedFilePath
      && draftContent !== syncedFile.content;
    if (hasLocalDirtyDraft) return;
    saveWorkspaceFileQueueRef.current?.seed(selectedFilePath, serverContent);
    const localContent = saveWorkspaceFileQueueRef.current?.localContent(selectedFilePath);
    syncedFileRef.current = { filePath: selectedFilePath, content: serverContent };
    setDraftContent(localContent ?? serverContent);
    setDraftFilePath(selectedFilePath);
  }, [draftContent, draftFilePath, fileQuery.data, selectedFilePath]);

  useEffect(() => {
    if (!selectedFilePath) return;
    const scroller = openFileTabScrollerElementRef.current;
    const selectedTab = openFileTabElementsRef.current.get(selectedFilePath);
    if (!scroller || !selectedTab) return;

    const frameId = window.requestAnimationFrame(() => {
      const scrollerRect = scroller.getBoundingClientRect();
      const tabRect = selectedTab.getBoundingClientRect();
      const leftOverflow = tabRect.left - scrollerRect.left;
      const rightOverflow = tabRect.right - scrollerRect.right;
      if (leftOverflow < 0) {
        scroller.scrollLeft += leftOverflow;
      } else if (rightOverflow > 0) {
        scroller.scrollLeft += rightOverflow;
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [openFilePaths, selectedFilePath]);

  const expandedDirectories = useMemo(
    () => {
      if (selectedFilePath) return parentDirectories(selectedFilePath);
      if (selectedSkillTreePath) return parentDirectories(selectedSkillTreePath);
      if (selectedResourcePath) return parentDirectories(selectedResourcePath);
      if (requestedDirectoryPath) return directoryAndParentDirectories(requestedDirectoryPath);
      return new Set<string>();
    },
    [requestedDirectoryPath, selectedFilePath, selectedResourcePath, selectedSkillTreePath],
  );

  const {
    clearNotice: clearWorkspaceFileSaveNotice,
    notices: workspaceFileSaveNotices,
    queue: saveWorkspaceFileQueue,
  } = useWorkspaceFileSaveQueue({
    organizationId: viewedOrganizationId,
    selectedFilePathRef,
    syncedFileRef,
  });
  saveWorkspaceFileQueueRef.current = saveWorkspaceFileQueue;
  const uploadWorkspaceImage = useMutation({
    mutationFn: async (payload: { file: File; filePath: string | null }) => {
      if (!viewedOrganizationId) throw new Error("No organization selected");
      return assetsApi.uploadImage(
        viewedOrganizationId,
        payload.file,
        workspaceImageAssetNamespace(payload.filePath),
      );
    },
  });
  const saveWorkspaceFileConflict = saveWorkspaceFileQueue.isConflicted(selectedFilePath);
  async function reloadWorkspaceFileAfterConflict() {
    const result = await fileQuery.refetch();
    const detail = result.data;
    if (!detail || detail.filePath !== selectedFilePath) return;
    const content = detail.content ?? "";
    saveWorkspaceFileQueue.resolveWithServer(detail.filePath, content);
    syncedFileRef.current = { filePath: detail.filePath, content };
    setDraftContent(content);
    setDraftFilePath(detail.filePath);
    clearWorkspaceFileSaveNotice(detail.filePath);
  }

  useEffect(() => () => {
    flushCurrentDraft();
  }, [flushCurrentDraft]);

  useEffect(() => {
    if (!tabContextMenu) return;

    const closeMenu = () => setTabContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    const attachCloseListenersId = window.setTimeout(() => {
      window.addEventListener("pointerdown", closeMenu);
      window.addEventListener("resize", closeMenu);
      window.addEventListener("scroll", closeMenu, true);
      window.addEventListener("keydown", handleKeyDown);
    }, 0);

    return () => {
      window.clearTimeout(attachCloseListenersId);
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    window.addEventListener(WORKSPACE_FLUSH_DRAFT_EVENT, flushCurrentDraft);
    return () => window.removeEventListener(WORKSPACE_FLUSH_DRAFT_EVENT, flushCurrentDraft);
  }, [flushCurrentDraft]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isWorkspaceCloseCurrentTabShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();

      const currentFilePath = selectedFilePathRef.current;
      if (!currentFilePath || !openFilePathsRef.current.includes(currentFilePath)) return;
      setTabContextMenu(null);
      handleCloseFileTab(currentFilePath);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleCloseFileTab]);

  const invalidateWorkspaceBrowser = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-files"] }),
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-file"] }),
    ]);
  }, [queryClient, viewedOrganizationId]);

  const removeProjectResourceAttachment = useMutation({
    mutationFn: (payload: { project: Project; attachment: ProjectResourceAttachment }) =>
      projectsApi.removeResourceAttachment(payload.project.id, payload.attachment.id, payload.project.orgId),
    onSuccess: (removed, payload) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(payload.project.orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.resources(payload.project.id) });
      if (requestedResourceAttachmentId === payload.attachment.id) {
        setSelectedFilePath(null);
        setDraftFilePath(null);
        updateSelectedPath(searchParams, setSearchParams, null);
        setActiveEntryPath(projectResourceFolderPath(payload.project));
      }
      pushToast({
        title: "Resource unlinked",
        body: removed.resource.name,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to unlink resource",
        tone: "error",
      });
    },
  });

  const deleteLegacyHeartbeatInstructions = useMutation({
    mutationFn: () => organizationsApi.deleteLegacyHeartbeatInstructions(viewedOrganizationId!),
    onSuccess: (result) => {
      if (!viewedOrganizationId) return;
      const deletedPaths = new Set(result.deleted.map((entry) => entry.path));
      void invalidateWorkspaceBrowser();
      setLegacyHeartbeatDialogPath(null);
      setOpenFilePaths((current) =>
        current.filter((filePath) => !isLegacyAgentHeartbeatInstructionPath(filePath) && !deletedPaths.has(filePath)),
      );
      if (isLegacyAgentHeartbeatInstructionPath(selectedFilePath) || (selectedFilePath && deletedPaths.has(selectedFilePath))) {
        setSelectedFilePath(null);
        setDraftFilePath(null);
        syncedFileRef.current = { filePath: null, content: "" };
        updateSelectedPath(searchParams, setSearchParams, null);
      } else if (isLegacyAgentHeartbeatInstructionPath(requestedFilePath)) {
        updateSelectedPath(searchParams, setSearchParams, null);
      }
      const activePath = activeEntryPath;
      if (activePath && (isLegacyAgentHeartbeatInstructionPath(activePath) || deletedPaths.has(activePath))) {
        setActiveEntryPath(parentWorkspaceDirectoryPath(activePath) || null);
      }
      pushToast({
        title: "Legacy heartbeat files deleted",
        body: `${result.deleted.length} file${result.deleted.length === 1 ? "" : "s"} removed`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to delete legacy heartbeat files",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!viewedOrganizationId) return;
    const refreshFromDisk = () => {
      flushCurrentDraft();
      void invalidateWorkspaceBrowser();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshFromDisk();
    };
    window.addEventListener("focus", refreshFromDisk);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshFromDisk);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushCurrentDraft, invalidateWorkspaceBrowser, viewedOrganizationId]);

  const renameWorkspaceEntry = useMutation({
    mutationFn: (payload: { entry: OrganizationWorkspaceFileEntry; name: string }) =>
      organizationsApi.renameWorkspaceEntry(viewedOrganizationId!, payload.entry.path, {
        name: payload.name,
      }),
    onSuccess: (result) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      setRenameTarget(null);
      setRenameDraft("");

      const previousPath = result.previousPath;
      if (previousPath && selectedFilePath) {
        setOpenFilePaths((current) => current.map((filePath) => {
          if (filePath === previousPath) return result.path;
          if (filePath.startsWith(`${previousPath}/`)) {
            return `${result.path}${filePath.slice(previousPath.length)}`;
          }
          return filePath;
        }));
        const nextSelectedPath = selectedFilePath === previousPath
          ? result.path
          : selectedFilePath.startsWith(`${previousPath}/`)
            ? `${result.path}${selectedFilePath.slice(previousPath.length)}`
            : selectedFilePath;
        if (nextSelectedPath !== selectedFilePath) {
          setSelectedFilePath(nextSelectedPath);
          setDraftFilePath(nextSelectedPath);
          if (syncedFileRef.current.filePath === previousPath) {
            syncedFileRef.current = { ...syncedFileRef.current, filePath: nextSelectedPath };
          }
          updateSelectedPath(searchParams, setSearchParams, nextSelectedPath);
        }
      }
      if (previousPath && activeEntryPath) {
        setActiveEntryPath(applyMovedWorkspacePath(activeEntryPath, previousPath, result.path));
      }
      pushToast({
        title: "Workspace entry renamed",
        body: result.previousPath ? `${result.previousPath} -> ${result.path}` : result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to rename workspace entry",
        tone: "error",
      });
    },
  });

  const moveWorkspaceEntry = useMutation({
    mutationFn: (payload: {
      entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">;
      destinationDirectoryPath: string;
    }) =>
      organizationsApi.moveWorkspaceEntry(viewedOrganizationId!, payload.entry.path, {
        destinationDirectoryPath: payload.destinationDirectoryPath,
      }),
    onSuccess: (result) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      const previousPath = result.previousPath;
      if (previousPath) {
        setOpenFilePaths((current) =>
          current.map((filePath) => applyMovedWorkspacePath(filePath, previousPath, result.path)),
        );
        if (selectedFilePath) {
          const nextSelectedPath = applyMovedWorkspacePath(selectedFilePath, previousPath, result.path);
          if (nextSelectedPath !== selectedFilePath) {
            setSelectedFilePath(nextSelectedPath);
            setDraftFilePath(nextSelectedPath);
            if (syncedFileRef.current.filePath === previousPath) {
              syncedFileRef.current = { ...syncedFileRef.current, filePath: nextSelectedPath };
            }
            updateSelectedPath(searchParams, setSearchParams, nextSelectedPath);
          }
        }
        if (activeEntryPath) {
          setActiveEntryPath(applyMovedWorkspacePath(activeEntryPath, previousPath, result.path));
        }
      }
      pushToast({
        title: "Workspace entry moved",
        body: result.previousPath ? `${result.previousPath} -> ${result.path}` : result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to move workspace entry",
        tone: "error",
      });
    },
  });

  const copyWorkspaceEntry = useMutation({
    mutationFn: (entry: OrganizationWorkspaceFileEntry) => {
      flushCurrentDraft();
      return organizationsApi.copyWorkspaceEntry(viewedOrganizationId!, entry.path);
    },
    onSuccess: (result) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      setActiveEntryPath(result.path);
      if (!result.isDirectory) {
        setSelectedFilePath(result.path);
        openWorkspaceFileTab(result.path);
        setDraftFilePath(null);
        updateSelectedPath(searchParams, setSearchParams, result.path);
      }
      pushToast({
        title: "Workspace entry copied",
        body: result.previousPath ? `${result.previousPath} -> ${result.path}` : result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to copy workspace entry",
        tone: "error",
      });
    },
  });

  const createWorkspaceEntry = useMutation({
    mutationFn: async (payload: {
      parent: OrganizationWorkspaceFileEntry;
      kind: "file" | "folder";
      name: string;
    }) => {
      requestWorkspaceDraftFlush();
      const entryPath = joinWorkspaceEntryPath(payload.parent.path, payload.name.trim());
      if (payload.kind === "folder") {
        return {
          kind: payload.kind,
          result: await organizationsApi.createWorkspaceDirectory(viewedOrganizationId!, {
            directoryPath: entryPath,
          }),
        };
      }
      return {
        kind: payload.kind,
        result: await organizationsApi.createWorkspaceFile(viewedOrganizationId!, {
          filePath: entryPath,
          content: "",
        }),
      };
    },
    onSuccess: ({ kind, result }) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      setCreateTarget(null);
      setCreateDraft("");
      if (kind === "file" && "filePath" in result) {
        queryClient.setQueryData(
          queryKeys.organizations.workspaceFile(viewedOrganizationId, result.filePath),
          result,
        );
        setSelectedFilePath(result.filePath);
        openWorkspaceFileTab(result.filePath);
        setDraftFilePath(result.filePath);
        syncedFileRef.current = { filePath: result.filePath, content: result.content ?? "" };
        updateSelectedPath(searchParams, setSearchParams, result.filePath);
        setDraftContent(result.content ?? "");
      }
      const createdPath = "filePath" in result ? result.filePath : result.path;
      pushToast({
        title: kind === "file" ? "File created" : "Folder created",
        body: createdPath,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to create workspace entry",
        tone: "error",
      });
    },
  });

  const importWorkspaceFiles = useMutation({
    mutationFn: async (payload: { files: File[]; destinationDirectoryPath: string; unsupportedCount?: number }) => {
      flushCurrentDraft();
      const result = await createWorkspaceFilesFromDroppedFiles(
        viewedOrganizationId!,
        payload.destinationDirectoryPath,
        payload.files,
      );
      return { ...result, unsupportedCount: payload.unsupportedCount ?? 0 };
    },
    onSuccess: ({ imported, failed, unsupportedCount }) => {
      if (!viewedOrganizationId) return;
      if (imported.length > 0) {
        void invalidateWorkspaceBrowser();
        for (const result of imported) {
          queryClient.setQueryData(
            queryKeys.organizations.workspaceFile(viewedOrganizationId, result.filePath),
            result,
          );
        }
      }
      const lastResult = imported.at(-1);
      if (lastResult) {
        setSelectedFilePath(lastResult.filePath);
        openWorkspaceFileTab(lastResult.filePath);
        setDraftFilePath(lastResult.filePath);
        syncedFileRef.current = { filePath: lastResult.filePath, content: lastResult.content ?? "" };
        updateSelectedPath(searchParams, setSearchParams, lastResult.filePath);
        setDraftContent(lastResult.content ?? "");
        setActiveEntryPath(lastResult.filePath);
      }
      const failedSummary = [
        ...failed.map((failure) => `${failure.fileName}: ${failure.message}`),
        ...(unsupportedCount > 0 ? [`${unsupportedCount} unsupported file${unsupportedCount === 1 ? "" : "s"}`] : []),
      ].join(", ");
      if (imported.length === 0) {
        pushToast({
          title: "No files imported",
          body: failedSummary || "Only text, Markdown, and code files can be imported.",
          tone: failed.length > 0 ? "error" : "warn",
        });
        return;
      }
      pushToast({
        title: failed.length > 0 || unsupportedCount > 0
          ? `Imported ${imported.length} of ${imported.length + failed.length + unsupportedCount} files`
          : imported.length === 1 ? "File imported" : `${imported.length} files imported`,
        body: failedSummary
          ? `${imported.map((result) => result.filePath).join(", ")}. Failed: ${failedSummary}`
          : imported.map((result) => result.filePath).join(", "),
        tone: failed.length > 0 || unsupportedCount > 0 ? "warn" : "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to import files",
        tone: "error",
      });
    },
  });

  const deleteWorkspaceEntry = useMutation({
    mutationFn: (entry: OrganizationWorkspaceFileEntry) =>
      organizationsApi.deleteWorkspaceEntry(viewedOrganizationId!, entry.path),
    onSuccess: (result) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      setDeleteTarget(null);
      setOpenFilePaths((current) =>
        current.filter((filePath) => filePath !== result.path && !filePath.startsWith(`${result.path}/`)),
      );
      if (selectedFilePath && (selectedFilePath === result.path || selectedFilePath.startsWith(`${result.path}/`))) {
        setSelectedFilePath(null);
        setDraftFilePath(null);
        syncedFileRef.current = { filePath: null, content: "" };
        updateSelectedPath(searchParams, setSearchParams, null);
      }
      if (activeEntryPath && (activeEntryPath === result.path || activeEntryPath.startsWith(`${result.path}/`))) {
        setActiveEntryPath(parentWorkspaceDirectoryPath(result.path) || null);
      }
      pushToast({
        title: "Workspace entry deleted",
        body: result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to delete workspace entry",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!selectedFilePath) return;
    if (draftFilePath !== selectedFilePath) return;
    const detail = fileQuery.data;
    if (!detail || detail.filePath !== selectedFilePath) return;
    if (detail.content === null || detail.truncated) return;
    if (draftContent === detail.content) return;
    if (saveWorkspaceFileConflict) return;

    const timeout = window.setTimeout(() => {
      const syncedFile = syncedFileRef.current;
      if (syncedFile.filePath !== selectedFilePath) return;
      saveWorkspaceFileQueue.enqueue(
        selectedFilePath,
        draftContent,
        syncedFile.content,
      );
    }, 700);

    return () => window.clearTimeout(timeout);
  }, [
    draftContent,
    draftFilePath,
    fileQuery.data,
    saveWorkspaceFileConflict,
    saveWorkspaceFileQueue,
    selectedFilePath,
  ]);

  const workspaceRootPath = rootQuery.data?.rootExists ? rootQuery.data.rootPath : null;
  const selectedWorkspaceLaunchTarget = (
    lastWorkspaceLaunchTargetId
      ? workspaceLaunchTargets.find((target) => target.id === lastWorkspaceLaunchTargetId)
      : null
  ) ?? workspaceLaunchTargets[0] ?? null;
  const workspaceRootEntry = useMemo<OrganizationWorkspaceFileEntry>(
    () => ({ name: "", path: "", isDirectory: true, displayLabel: libraryCopy("library", locale) }),
    [locale],
  );
  const handleStartCreateRootEntry = useCallback((kind: "file" | "folder") => {
    flushCurrentDraft();
    setCreateTarget({ parent: workspaceRootEntry, kind });
    setCreateDraft(kind === "file" ? "untitled.md" : "new-folder");
  }, [flushCurrentDraft, workspaceRootEntry]);

  const handleCopyEntry = useCallback((entry: OrganizationWorkspaceFileEntry) => {
    if (!canCopyWorkspaceEntry(entry)) return;
    copyWorkspaceEntry.mutate(entry);
  }, [copyWorkspaceEntry]);

  const handleOpenWorkspaceTarget = useCallback(async (
    rootPath: string,
    target: DesktopWorkspaceLaunchTarget,
    toastLabel = "workspace",
  ) => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.openWorkspace) return;

    setOpeningWorkspaceTargetId(target.id);
    try {
      await desktopShell.openWorkspace(rootPath, target.id);
      setLastWorkspaceLaunchTargetId(target.id);
      writeStoredWorkspaceLaunchTargetId(target.id);
      pushToast({
        title: `Opened ${toastLabel} in ${target.label}`,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: `Failed to open ${toastLabel}`,
        body: error instanceof Error ? error.message : `Could not open the ${toastLabel} in ${target.label}.`,
        tone: "error",
      });
    } finally {
      setOpeningWorkspaceTargetId(null);
    }
  }, [pushToast]);

  const handleOpenEntryTarget = useCallback(async (
    entry: OrganizationWorkspaceFileEntry,
    target: DesktopWorkspaceLaunchTarget | WorkspaceFileOpenTarget,
  ) => {
    if (entry.isDirectory) {
      if (isWorkspaceFileOpenTarget(target)) return;
      await handleOpenWorkspaceTarget(joinWorkspacePath(workspaceRootPath, entry.path), target, "folder");
      return;
    }

    if (!workspaceRootPath) return;
    const desktopShell = readDesktopShell();
    if (typeof desktopShell?.openWorkspaceFileInIde !== "function") return;

    const fileTarget = isWorkspaceFileOpenTarget(target)
      ? target
      : workspaceFileOpenTargets([target]).find((candidate) => candidate.id === target.id);
    if (!fileTarget) return;

    setOpeningWorkspaceTargetId(fileTarget.id);
    try {
      await desktopShell.openWorkspaceFileInIde(workspaceRootPath, entry.path, fileTarget.id);
      if (fileTarget.workspaceTarget) {
        setLastWorkspaceLaunchTargetId(fileTarget.workspaceTarget.id);
        writeStoredWorkspaceLaunchTargetId(fileTarget.workspaceTarget.id);
      }
      pushToast({
        title: fileTarget.id === "defaultApp" ? "Opened file" : `Opened file in ${fileTarget.label}`,
        body: entry.path,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to open file",
        body: error instanceof Error ? error.message : `Could not open ${entry.path} in ${fileTarget.label}.`,
        tone: "error",
      });
    } finally {
      setOpeningWorkspaceTargetId(null);
    }
  }, [handleOpenWorkspaceTarget, pushToast, workspaceRootPath]);

  const handleSelectWorkspaceLaunchTarget = useCallback((target: DesktopWorkspaceLaunchTarget) => {
    setLastWorkspaceLaunchTargetId(target.id);
    writeStoredWorkspaceLaunchTargetId(target.id);
  }, []);

  const handleOpenUnsupportedFileTarget = useCallback(async (
    filePath: string,
    target: WorkspaceUnsupportedFileLaunchTarget,
  ) => {
    if (!workspaceRootPath) return;
    const desktopShell = readDesktopShell();
    const openTarget = isWorkspaceFileOpenTarget(target)
      ? desktopShell?.openWorkspaceFileInIde
      : desktopShell?.openWorkspaceFileLocation;
    if (typeof openTarget !== "function") return;

    setOpeningWorkspaceTargetId(target.id);
    try {
      if (isWorkspaceFileOpenTarget(target)) {
        await desktopShell!.openWorkspaceFileInIde(workspaceRootPath, filePath, target.id);
      } else {
        await desktopShell!.openWorkspaceFileLocation!(workspaceRootPath, filePath, target.id);
      }
      setLastUnsupportedFileLaunchTargetId(target.id);
      writeStoredWorkspaceUnsupportedFileLaunchTargetId(target.id);
      pushToast({
        title: target.id === "defaultApp" ? "Opened file" : `Opened file with ${target.label}`,
        body: filePath,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to open file",
        body: error instanceof Error ? error.message : `Could not open ${filePath} with ${target.label}.`,
        tone: "error",
      });
    } finally {
      setOpeningWorkspaceTargetId(null);
    }
  }, [pushToast, workspaceRootPath]);

  useEffect(() => {
    if (!isMobileViewport || requestedDocumentId) {
      setHeaderActions(null);
      return () => setHeaderActions(null);
    }

    setHeaderActions(
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => handleStartCreateRootEntry("file")}
          disabled={!workspaceRootPath}
          aria-label="New file"
          data-testid="org-workspaces-new-file-button"
        >
          <FilePlus2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => handleStartCreateRootEntry("folder")}
          disabled={!workspaceRootPath}
          aria-label="New folder"
          data-testid="org-workspaces-new-folder-button"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        {workspaceRootPath && !selectedProjectResource ? (
          <WorkspaceLaunchMenu
            rootPath={workspaceRootPath}
            targets={workspaceLaunchTargets}
            openingTargetId={workspaceLaunchMenuOpeningId(openingWorkspaceTargetId)}
            onOpenTarget={handleOpenWorkspaceTarget}
            className="h-8 w-8"
            testId="org-workspaces-launcher"
            targetTestIdPrefix="org-workspaces-launch-target"
          />
        ) : null}
      </div>,
    );

    return () => setHeaderActions(null);
  }, [
    handleOpenWorkspaceTarget,
    handleStartCreateRootEntry,
    isMobileViewport,
    openingWorkspaceTargetId,
    requestedDocumentId,
    selectedProjectResource,
    setHeaderActions,
    workspaceLaunchTargets,
    workspaceRootPath,
  ]);

  if (!viewedOrganizationId || !viewedOrganization) {
    return <EmptyState icon={HardDrive} message={emptyMessage} />;
  }

  if (requestedDocumentId) {
    if (legacyDocumentQuery.isLoading) {
      return <PageSkeleton variant="detail" />;
    }
    if (legacyDocumentQuery.error) {
      return <EmptyState icon={FileText} message={libraryCopy("libraryDocumentUnavailable", locale)} />;
    }
    const document = legacyDocumentQuery.data;
    if (!document) return null;
    const title = document.title?.trim() || `Document ${document.id.slice(0, 8)}`;
    const documentWordCount = countWorkspaceDocumentWords(document.body);
    const issueLink = document.issueLinks?.[0] ?? null;

    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="org-workspaces-legacy-document">
        <div className="shrink-0 border-b border-[color:var(--border-soft)] px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>{libraryCopy("legacyLibraryDocument", locale)}</span>
                {issueLink ? (
                  <>
                    <span aria-hidden="true">/</span>
                    <span className="truncate">
                      migrated from {issueLink.issueIdentifier ?? issueLink.issueId.slice(0, 8)}:{issueLink.key}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <span>r{document.latestRevisionNumber}</span>
              <span aria-hidden="true">/</span>
              <span>{formatWorkspaceWordCount(documentWordCount)}</span>
            </div>
          </div>
        </div>
        <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-auto bg-[color:var(--surface-elevated)]">
          <article className="mx-auto w-full max-w-[880px] px-8 py-8">
            <MarkdownBody className="rudder-library-document-editor text-[15px] leading-7 text-foreground">
              {document.body}
            </MarkdownBody>
          </article>
        </div>
      </div>
    );
  }

  if (rootQuery.isLoading && !selectedFilePath && !requestedEntryPath && !requestedDirectoryPath && !selectedResourcePath && !requestedSkillId) {
    return <PageSkeleton variant="detail" />;
  }

  if (rootQuery.error) {
    return <p className="text-sm text-destructive">{rootQuery.error.message}</p>;
  }

  if (requestedEntryId) {
    if (libraryEntryQuery.isLoading && !requestedEntryPath) {
      return <PageSkeleton variant="detail" />;
    }
    if (libraryEntryQuery.error && !requestedEntryPath) {
      return <EmptyState icon={FileText} message="This Library reference could not be found or is not available in this organization." />;
    }
    if (libraryEntryQuery.data && (libraryEntryQuery.data.status !== "active" || !libraryEntryQuery.data.currentPath)) {
      return <EmptyState icon={FileText} message="This Library reference no longer points to an active workspace file." />;
    }
  }

  const workspace = rootQuery.data ?? {
    rootExists: true,
    rootPath: "",
    directoryPath: "",
    entries: [],
    message: null,
  };
  const workspaceRootTreeEntries = mergeWorkspaceAndVirtualSkillEntries("", workspace.entries, organizationSkills);

  const handleSelectFile = (filePath: string) => {
    setTabContextMenu(null);
    if (isLegacyAgentHeartbeatInstructionPath(filePath)) {
      setLegacyHeartbeatDialogPath(filePath);
      setActiveEntryPath(filePath);
      return;
    }
    flushCurrentDraft();
    allowDefaultFileOpenRef.current = true;
    openWorkspaceFileTab(filePath);
    setActiveEntryPath(filePath);
    setSelectedFilePath(filePath);
    updateSelectedPath(searchParams, setSearchParams, filePath);
  };

  function handleSelectSkillFile(skillId: string, filePath: string, treePath: string) {
    setTabContextMenu(null);
    flushCurrentDraft();
    setSelectedFilePath(null);
    setDraftFilePath(null);
    setActiveEntryPath(treePath);
    updateSelectedSkillFile(searchParams, setSearchParams, skillId, filePath);
  }

  function handleKeepLegacyHeartbeatFiles() {
    setLegacyHeartbeatDialogPath(null);
    if (isLegacyAgentHeartbeatInstructionPath(requestedFilePath) || isLegacyAgentHeartbeatInstructionPath(selectedFilePath)) {
      setSelectedFilePath(null);
      setDraftFilePath(null);
      updateSelectedPath(searchParams, setSearchParams, null);
    }
    setOpenFilePaths((current) => current.filter((filePath) => !isLegacyAgentHeartbeatInstructionPath(filePath)));
  }

  const handleSelectResource = (attachmentId: string) => {
    setTabContextMenu(null);
    flushCurrentDraft();
    const selection = findProjectResourceSelection(projectResourceTree.projects, attachmentId);
    setActiveEntryPath(selection?.path ?? null);
    setSelectedFilePath(null);
    setDraftFilePath(null);
    updateSelectedResource(searchParams, setSearchParams, attachmentId);
  };

  const handleLibraryInlineTokenClick = (token: AtomicInlineTokenElement, _event: InlineTokenClickEvent) => {
    if (token.kind === "skill") {
      const detailsHref = token.element
        .closest<HTMLAnchorElement>("a[data-skill-token='true'][href]")
        ?.getAttribute("href")
        ?? agentWorkspaceMentionOptions.find((option) => (
          option.kind === "skill"
          && option.skillMarkdownTarget === token.href
        ))?.skillDetailsHref;
      if (detailsHref) navigate(detailsHref);
      return;
    }
    const parsed = parseMentionChipHref(token.href);
    if (!parsed) return;
    if (parsed.kind === "library_file") {
      handleSelectFile(parsed.filePath);
      return;
    }
    navigate(mentionChipNavigationPath(parsed));
  };

  function handleCloseOtherFileTabs(filePath: string) {
    flushCurrentDraft();
    setOpenFilePaths([filePath]);
    setSelectedFilePath(filePath);
    updateSelectedPath(searchParams, setSearchParams, filePath);
    setTabContextMenu(null);
  }

  function handleCloseTabsToRight(filePath: string) {
    flushCurrentDraft();
    setOpenFilePaths((current) => {
      const tabIndex = current.indexOf(filePath);
      if (tabIndex === -1) return current;
      const next = current.slice(0, tabIndex + 1);
      if (selectedFilePath && !next.includes(selectedFilePath)) {
        setSelectedFilePath(filePath);
        updateSelectedPath(searchParams, setSearchParams, filePath);
      }
      return next;
    });
    setTabContextMenu(null);
  }

  function handleCloseAllFileTabs() {
    flushCurrentDraft();
    allowDefaultFileOpenRef.current = false;
    setOpenFilePaths([]);
    setSelectedFilePath(null);
    setDraftFilePath(null);
    updateSelectedPath(searchParams, setSearchParams, null);
    setTabContextMenu(null);
  }

  const selectedFileDetail = fileQuery.data;
  const selectedVirtualSkillFileDetail = selectedVirtualOrganizationSkill
    ? virtualSkillFileQuery.data as OrganizationSkillFileDetail | undefined
    : undefined;
  const selectedVirtualSkillContent = selectedVirtualSkillFileDetail?.content ?? "";
  const selectedVirtualSkillMarkdownParts = splitYamlFrontmatter(selectedVirtualSkillContent);
  const selectedVirtualSkillDisplayPath = selectedVirtualOrganizationSkill && selectedVirtualSkillFileDetail
    ? organizationSkillFileTreePath(selectedVirtualOrganizationSkill, selectedVirtualSkillFileDetail.path)
    : selectedSkillTreePath;
  const selectedEditorContent = draftFilePath === selectedFilePath
    ? draftContent
    : selectedFileDetail?.content ?? "";
  const selectedMarkdownParts = splitYamlFrontmatter(selectedEditorContent);
  const selectedMarkdownBodyForEditor = selectedMarkdownParts.body;
  const selectedFileUsesMarkdownEditor = isWorkspaceMarkdownFilePath(selectedFilePath);
  const selectedFileUsesCsvEditor = Boolean(
    selectedFileDetail?.content !== null
    && selectedFileDetail?.previewKind === "text"
    && (isWorkspaceCsvFilePath(selectedFilePath) || isWorkspaceCsvContentType(selectedFileDetail?.contentType)),
  );
  const selectedCsvParseResult = selectedFileUsesCsvEditor
    ? parseWorkspaceCsvContent(selectedEditorContent)
    : null;
  const selectedFileUsesCodeEditor = isWorkspaceCodeFilePath(selectedFilePath);
  const selectedCsvShape = selectedCsvParseResult
    ? normalizeWorkspaceCsvRows(selectedCsvParseResult.rows)
    : null;
  const selectedFileCanRenderHtml = Boolean(
    selectedFileDetail?.content !== null
    && selectedFileDetail?.previewKind === "text"
    && (isWorkspaceHtmlFilePath(selectedFilePath) || isWorkspaceHtmlContentType(selectedFileDetail?.contentType)),
  );
  const selectedFileUsesHtmlPreview = selectedFileCanRenderHtml && htmlFileMode === "preview";
  const selectedHtmlPreviewIdentity = `${viewedOrganizationId ?? ""}:${selectedFilePath ?? ""}`;
  const selectedHtmlNetworkMode = htmlNetworkSelection.identity === selectedHtmlPreviewIdentity
    ? htmlNetworkSelection.mode
    : "connected";
  const selectedMarkdownOutlineWithHidden = selectedFileUsesMarkdownEditor
    ? extractDocumentOutline(selectedMarkdownParts.body, { includeHidden: true })
    : [];
  const selectedMarkdownHasHiddenOutlineItems = selectedMarkdownOutlineWithHidden.some((item) => item.hidden);
  const selectedMarkdownOutline = selectedFileUsesMarkdownEditor
    ? showHiddenMarkdownSections
      ? selectedMarkdownOutlineWithHidden
      : selectedMarkdownOutlineWithHidden.filter((item) => !item.hidden)
    : [];
  const showSelectedMarkdownOutlinePanel = selectedMarkdownOutline.length > 0 || selectedMarkdownHasHiddenOutlineItems;
  const renderSelectedMarkdownOutlinePanel = showSelectedMarkdownOutlinePanel && !markdownOutlineCollapsed;
  const selectedDirectoryPath = !selectedFilePath && !selectedProjectResource
    ? requestedDirectoryPath
    : null;
  const visibleWorkspaceBreadcrumbPath = selectedFilePath ?? selectedVirtualSkillDisplayPath ?? selectedDirectoryPath;
  const visibleWorkspaceBreadcrumbKind = selectedFilePath || selectedVirtualSkillDisplayPath ? "file" : "directory";
  const showWorkspaceFileTabs = openFilePaths.length > 0;
  const emptyStateCreateTarget: OrganizationWorkspaceFileEntry = {
    name: selectedDirectoryPath?.split("/").filter(Boolean).at(-1) ?? "",
    path: selectedDirectoryPath ?? "",
    isDirectory: true,
    displayLabel: selectedDirectoryPath ? displayWorkspaceFileTabLabel(selectedDirectoryPath) : libraryCopy("library", locale),
  };
  const emptyStateOpenFolderPath = joinWorkspacePath(workspaceRootPath, selectedDirectoryPath ?? "");
  const selectedDocumentWordCount = countWorkspaceDocumentWords(
    selectedFileUsesMarkdownEditor ? selectedMarkdownParts.body : selectedEditorContent,
  );
  const selectedStatusSegments = selectedFileUsesCsvEditor && selectedCsvShape
    ? [
        "CSV",
        `${selectedCsvShape.rows.length.toLocaleString()} ${selectedCsvShape.rows.length === 1 ? "row" : "rows"}`,
        `${selectedCsvShape.columnCount.toLocaleString()} ${selectedCsvShape.columnCount === 1 ? "column" : "columns"}`,
      ]
    : [
        selectedFileUsesCodeEditor
          ? getWorkspaceCodeLanguageLabel(selectedFilePath)
          : displayWorkspaceDocumentKind(selectedFilePath),
        formatWorkspaceWordCount(selectedDocumentWordCount),
      ];
  const selectedWorkspaceSaveNotice = selectedFilePath
    ? workspaceFileSaveNotices.get(selectedFilePath) ?? null
    : null;
  const selectedWorkspaceSaveError = selectedWorkspaceSaveNotice?.status === "error"
    ? selectedWorkspaceSaveNotice.error
    : null;
  const selectedWorkspaceSavePending = selectedWorkspaceSaveNotice?.status === "saving";
  const selectedSaveStatus = selectedWorkspaceSaveError
    ? "Save failed"
    : draftFilePath === selectedFilePath && syncedFileRef.current.filePath === selectedFilePath && draftContent !== syncedFileRef.current.content
      ? "Saving"
      : "Saved";
  const libraryFindRefreshKey = [
    selectedFilePath ?? "",
    selectedFileDetail?.filePath ?? "",
    selectedFileDetail?.previewKind ?? "",
    selectedFileDetail?.contentPath ?? "",
    selectedFileDetail?.message ?? "",
    selectedFileDetail?.truncated ? "truncated" : "full",
    selectedEditorContent,
    selectedVirtualSkillDisplayPath ?? "",
    selectedVirtualSkillContent,
  ].join(":");
  const canEditSelectedFile = Boolean(
    selectedFilePath
    && selectedFileDetail
    && selectedFileDetail.content !== null
    && !selectedFileDetail.truncated,
  );
  const primaryIde = availableIdes[0] ?? null;
  const tabContextMenuIndex = tabContextMenu ? openFilePaths.indexOf(tabContextMenu.filePath) : -1;
  const canCloseOtherTabs = Boolean(tabContextMenu && openFilePaths.length > 1);
  const canCloseTabsToRight = tabContextMenuIndex >= 0 && tabContextMenuIndex < openFilePaths.length - 1;
  const selectedHtmlFileOpenTargets = selectedFilePath
    && workspaceRootPath
    && typeof readDesktopShell()?.openWorkspaceFileInIde === "function"
    ? workspaceFileOpenTargets(workspaceLaunchTargets)
    : [];
  const selectedHtmlFileEntry: OrganizationWorkspaceFileEntry | null = selectedFilePath
    ? {
        name: displayWorkspaceFileTabLabel(selectedFilePath),
        path: selectedFilePath,
        isDirectory: false,
      }
    : null;
  const selectedHtmlFileOpenAction = selectedHtmlFileEntry ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Open file options"
          data-testid="org-workspaces-html-open-menu"
        >
          <ExternalLink className="workspace-html-preview-open-icon" data-icon="inline-start" />
          Open
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {selectedHtmlFileOpenTargets.length > 0 ? (
          selectedHtmlFileOpenTargets.map((target) => (
            <DropdownMenuItem
              key={target.id}
              disabled={openingWorkspaceTargetId !== null}
              data-testid={`org-workspaces-html-open-target-${target.id}`}
              onSelect={() => void handleOpenEntryTarget(selectedHtmlFileEntry, target)}
            >
              {openingWorkspaceTargetId === target.id ? (
                <Loader2 className="animate-spin" />
              ) : (
                <WorkspaceLaunchTargetIcon target={target} />
              )}
              <span className="min-w-0 flex-1 truncate">{target.label}</span>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>
            <ExternalLink />
            Available in Rudder Desktop
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  const selectedFileDesktopShell = readDesktopShell();
  const selectedUnsupportedFileLaunchTargets = workspaceRootPath
    ? workspaceUnsupportedFileLaunchTargets(workspaceLaunchTargets, {
        canOpenFile: typeof selectedFileDesktopShell?.openWorkspaceFileInIde === "function",
        canOpenLocation: typeof selectedFileDesktopShell?.openWorkspaceFileLocation === "function",
      })
    : [];
  const selectedUnsupportedFileLaunchTarget = resolveWorkspaceUnsupportedFileLaunchTarget(
    selectedUnsupportedFileLaunchTargets,
    lastUnsupportedFileLaunchTargetId,
  );

  function scrollToSelectedMarkdownOutlineItem(item: DocumentOutlineItem) {
    markdownEditorRef.current?.revealLine?.(item.line);
  }

  function handleMarkdownEditorBlankClick(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest("button, a, input, textarea, select, [role='button'], [role='menu'], [role='listbox']")) {
      return;
    }
    if (event.target.closest(".ProseMirror, [data-editor-engine='codemirror-live-preview']")) return;
    markdownEditorRef.current?.focus();
  }

  async function handleOpenFileInIde(filePath: string) {
    if (!primaryIde || !workspaceRootPath) return;
    const desktopShell = readDesktopShell();
    if (!desktopShell) return;
    if (typeof desktopShell.openWorkspaceFileInIde !== "function") return;

    try {
      await desktopShell.openWorkspaceFileInIde(workspaceRootPath, filePath, primaryIde.id);
      pushToast({
        title: "Opened in IDE",
        body: `Opened ${filePath} in ${primaryIde.label}.`,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to open in IDE",
        body: error instanceof Error ? error.message : "Could not open the selected workspace file in a local IDE.",
        tone: "error",
      });
    }
  }

  async function handleCopyWorkspaceLink(filePath: string) {
    const label = displayWorkspaceFileTabLabel(filePath);
    const cachedDetail = viewedOrganizationId
      ? queryClient.getQueryData<OrganizationWorkspaceFileDetail>(
        queryKeys.organizations.workspaceFile(viewedOrganizationId, filePath),
      )
      : null;
    const copyValue = buildWorkspaceFileLinkMarkdown(filePath, label, cachedDetail?.libraryEntryId ?? null);
    try {
      await copyWorkspaceText(copyValue);
      pushToast({
        title: "Library link copied",
        body: copyValue,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to copy Library link",
        body: error instanceof Error ? error.message : copyValue,
        tone: "error",
      });
    }
  }

  async function handleCopyWorkspaceAbsolutePath(entryPath: string) {
    const copyValue = joinWorkspacePath(workspaceRootPath, entryPath);
    try {
      await copyWorkspaceText(copyValue);
      pushToast({
        title: "Absolute path copied",
        body: copyValue,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to copy absolute path",
        body: error instanceof Error ? error.message : copyValue,
        tone: "error",
      });
    }
  }

  async function handleCopyEntryLink(entry: OrganizationWorkspaceFileEntry) {
    const copyValue = buildWorkspaceEntryLinkMarkdown(entry);
    try {
      await copyWorkspaceText(copyValue);
      pushToast({
        title: "Library link copied",
        body: copyValue,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to copy Library link",
        body: error instanceof Error ? error.message : copyValue,
        tone: "error",
      });
    }
  }

  async function handleCopyEntryAbsolutePath(entry: OrganizationWorkspaceFileEntry) {
    await handleCopyWorkspaceAbsolutePath(entry.path);
  }

  async function handleOpenEntryDefault(entry: OrganizationWorkspaceFileEntry) {
    const targetPath = joinWorkspacePath(workspaceRootPath, entry.path);
    const desktopShell = readDesktopShell();
    if (!desktopShell?.openPath) {
      return;
    }

    try {
      await desktopShell.openPath(targetPath);
      pushToast({
        title: entry.isDirectory ? "Opened folder" : "Opened in editor",
        body: targetPath,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: entry.isDirectory ? "Failed to open folder" : "Failed to open in editor",
        body: error instanceof Error ? error.message : targetPath,
        tone: "error",
      });
    }
  }

  function handleAddProjectResources(project: Project) {
    navigate(`/projects/${project.urlKey ?? project.id}/resources`);
  }

  async function handleCopyResourceLocator(attachment: ProjectResourceAttachment) {
    const copyValue = attachment.resource.locator;
    const desktopShell = readDesktopShell();
    try {
      if (desktopShell?.copyText) {
        await desktopShell.copyText(copyValue);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyValue);
      } else {
        throw new Error("Clipboard is not available in this environment.");
      }
      pushToast({
        title: "Resource locator copied",
        body: copyValue,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to copy resource locator",
        body: error instanceof Error ? error.message : copyValue,
        tone: "error",
      });
    }
  }

  async function handleOpenResourceDefault(attachment: ProjectResourceAttachment) {
    const locator = attachment.resource.locator.trim();
    const desktopShell = readDesktopShell();
    try {
      if (attachment.resource.kind === "url" || isHttpUrl(locator)) {
        if (desktopShell?.openExternal) {
          await desktopShell.openExternal(locator);
        } else {
          window.open(locator, "_blank", "noopener,noreferrer");
        }
        pushToast({ title: "Opened resource link", body: locator, tone: "info" });
        return;
      }

      const targetPath = resolveResourceOpenPath(attachment, workspaceRootPath);
      if (!targetPath || !desktopShell?.openPath) {
        throw new Error("This resource cannot be opened from the current shell.");
      }
      await desktopShell.openPath(targetPath);
      pushToast({ title: "Opened resource", body: targetPath, tone: "info" });
    } catch (error) {
      pushToast({
        title: "Failed to open resource",
        body: error instanceof Error ? error.message : locator,
        tone: "error",
      });
    }
  }

  function handleOpenTabContextMenu(event: MouseEvent<HTMLElement>, filePath: string) {
    event.preventDefault();
    event.stopPropagation();
    openTabContextMenu(filePath, event.clientX, event.clientY);
  }

  function openTabContextMenu(filePath: string, clientX: number, clientY: number) {
    setActiveEntryPath(filePath);
    setTabContextMenu({
      filePath,
      ...clampWorkspaceTabContextMenuPosition(clientX, clientY),
    });
  }

  function handleOpenFileTabDragStart(event: DragEvent<HTMLElement>, filePath: string) {
    if (openFilePaths.length < 2) {
      event.preventDefault();
      return;
    }
    setDraggedTabPath(filePath);
    setTabContextMenu(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKSPACE_TAB_DND_MIME, filePath);
    event.dataTransfer.setData("text/plain", filePath);
  }

  function handleOpenFileTabDragOver(event: DragEvent<HTMLElement>, targetFilePath: string) {
    const sourceFilePath = draggedTabPath || event.dataTransfer.getData(WORKSPACE_TAB_DND_MIME);
    if (!sourceFilePath || sourceFilePath === targetFilePath) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const targetRect = event.currentTarget.getBoundingClientRect();
    const insertBeforeTarget = event.clientX < targetRect.left + targetRect.width / 2;
    setTabDropPreview({
      targetPath: targetFilePath,
      position: insertBeforeTarget ? "before" : "after",
    });
  }

  function handleOpenFileTabDragLeave(event: DragEvent<HTMLElement>, targetFilePath: string) {
    if (!didDragLeaveCurrentTarget(event)) return;
    setTabDropPreview((current) => current?.targetPath === targetFilePath ? null : current);
  }

  function handleOpenFileTabDrop(event: DragEvent<HTMLElement>, targetFilePath: string) {
    event.preventDefault();
    const sourceFilePath = draggedTabPath || event.dataTransfer.getData(WORKSPACE_TAB_DND_MIME);
    if (!sourceFilePath || sourceFilePath === targetFilePath) {
      setDraggedTabPath(null);
      setTabDropPreview(null);
      return;
    }
    const targetRect = event.currentTarget.getBoundingClientRect();
    const insertBeforeTarget = event.clientX < targetRect.left + targetRect.width / 2;
    setOpenFilePaths((current) => {
      const sourceIndex = current.indexOf(sourceFilePath);
      const targetIndex = current.indexOf(targetFilePath);
      if (sourceIndex === -1 || targetIndex === -1) return current;
      const withoutSource = current.filter((candidate) => candidate !== sourceFilePath);
      const targetIndexAfterRemoval = withoutSource.indexOf(targetFilePath);
      const insertIndex = targetIndexAfterRemoval + (insertBeforeTarget ? 0 : 1);
      const next = [...withoutSource];
      next.splice(insertIndex, 0, sourceFilePath);
      return next.join("\u0000") === current.join("\u0000") ? current : next;
    });
    setDraggedTabPath(null);
    setTabDropPreview(null);
  }

  function handleOpenFileTabDragEnd() {
    setDraggedTabPath(null);
    setTabDropPreview(null);
  }

  function handleMarkdownDraftChange(filePath: string | null, nextContent: string) {
    if (!filePath || selectedFilePathRef.current !== filePath) return;
    setDraftFilePath(filePath);
    setDraftContent(nextContent);
  }

  function handleMarkdownBodyDraftChange(filePath: string | null, nextBody: string) {
    if (!filePath || selectedFilePathRef.current !== filePath) return;
    handleMarkdownDraftChange(
      filePath,
      joinYamlFrontmatter(
        selectedMarkdownParts.frontmatter,
        selectedMarkdownParts.frontmatterSeparator,
        nextBody,
      ),
    );
  }

  function handleFrontmatterDraftChange(filePath: string | null, nextFrontmatter: string) {
    if (!filePath || selectedFilePathRef.current !== filePath) return;
    handleMarkdownDraftChange(
      filePath,
      joinYamlFrontmatter(
        nextFrontmatter,
        selectedMarkdownParts.frontmatterSeparator,
        selectedMarkdownParts.body,
      ),
    );
  }

  function handleStartRename(entry: OrganizationWorkspaceFileEntry) {
    if (!canRenameWorkspaceEntry(entry)) return;
    setRenameTarget(entry);
    setRenameDraft(entry.name);
  }

  function handleStartDelete(entry: OrganizationWorkspaceFileEntry) {
    if (!canDeleteWorkspaceEntry(entry)) return;
    setDeleteTarget(entry);
  }

  function handleStartCreateEntry(entry: OrganizationWorkspaceFileEntry, kind: "file" | "folder") {
    if (!entry.isDirectory || !canCreateInsideWorkspaceDirectory(entry.path)) return;
    setCreateTarget({ parent: entry, kind });
    setCreateDraft(kind === "file" ? "untitled.md" : "new-folder");
  }

  function handleMoveEntry(
    entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">,
    destinationDirectoryPath: string,
  ) {
    setRootDropActive(false);
    if (!canDropWorkspaceEntryIntoDirectory(entry, destinationDirectoryPath)) return;
    flushCurrentDraft();
    moveWorkspaceEntry.mutate({ entry, destinationDirectoryPath });
  }

  function handleImportFiles(files: File[], destinationDirectoryPath: string, unsupportedCount = 0) {
    setRootDropActive(false);
    if (files.length === 0) {
      if (unsupportedCount > 0) {
        pushToast({
          title: "No files imported",
          body: "Only text, Markdown, and code files can be imported.",
          tone: "warn",
        });
      }
      return;
    }
    importWorkspaceFiles.mutate({ files, destinationDirectoryPath, unsupportedCount });
  }

  function handleRootDragOver(event: DragEvent<HTMLElement>) {
    if (!hasWorkspaceDragPayload(event.dataTransfer) && !hasExternalFileDragPayload(event.dataTransfer)) return;
    if (isDraggingOverWorkspaceTreeEntry(event)) {
      setRootDropActive(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = hasExternalFileDragPayload(event.dataTransfer) ? "copy" : "move";
    setRootDropActive(true);
  }

  function handleRootDragLeave(event: DragEvent<HTMLElement>) {
    if (didDragLeaveCurrentTarget(event)) {
      setRootDropActive(false);
    }
  }

  function handleRootDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setRootDropActive(false);
    if (hasExternalFileDragPayload(event.dataTransfer)) {
      const { supported, unsupportedCount } = getWorkspaceImportDropFiles(event.dataTransfer);
      handleImportFiles(supported, "", unsupportedCount);
      return;
    }
    const source = parseWorkspaceDragEntry(event);
    if (!source || !canDropWorkspaceEntryIntoDirectory(source, "")) return;
    handleMoveEntry(source, "");
  }

  const showInlineFiles = isMobileViewport;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!workspace.rootExists ? (
        <EmptyState
          icon={HardDrive}
          message={workspace.message ?? "The shared Library root is not available on this machine yet."}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:h-full lg:overflow-hidden lg:flex-row">
          {showInlineFiles ? (
            <section
              data-testid="org-workspaces-files-card"
              data-active-surface={importWorkspaceFiles.isPending ? "workspace-import" : undefined}
              className={cn(
                "flex min-h-[320px] flex-col rounded-[var(--radius-lg)] border border-border bg-card transition-colors lg:min-h-0 lg:w-[320px] lg:flex-none",
                rootDropActive && "bg-[#2f80ed]/5 ring-1 ring-inset ring-[#2f80ed]/25",
                importWorkspaceFiles.isPending && "active-surface-ring",
              )}
              onDragOver={handleRootDragOver}
              onDragLeave={handleRootDragLeave}
              onDrop={handleRootDrop}
            >
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{libraryCopy("library", locale)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {workspaceRootPath && !selectedProjectResource ? (
                    <WorkspaceLaunchMenu
                      rootPath={workspaceRootPath}
                      targets={workspaceLaunchTargets}
                      openingTargetId={workspaceLaunchMenuOpeningId(openingWorkspaceTargetId)}
                      onOpenTarget={handleOpenWorkspaceTarget}
                      contentAlign="start"
                      testId="org-workspaces-sidebar-launcher"
                      targetTestIdPrefix="org-workspaces-sidebar-launch-target"
                    />
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleStartCreateRootEntry("file")}
                        disabled={!workspaceRootPath}
                        aria-label="New file"
                        data-testid="org-workspaces-inline-new-file-button"
                      >
                        <FilePlus2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>New file</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleStartCreateRootEntry("folder")}
                        disabled={!workspaceRootPath}
                        aria-label="New folder"
                        data-testid="org-workspaces-inline-new-folder-button"
                      >
                        <FolderPlus className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>New folder</TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div
                ref={filesScrollRef}
                data-testid="org-workspaces-files-scroll"
                className="scrollbar-auto-hide min-h-0 flex-1 overflow-auto"
              >
                <div className="px-2 py-2">
                  {workspaceRootTreeEntries.length === 0 ? (
                    <div className="px-2 py-3 text-sm text-muted-foreground">
                      {workspace.message ?? "This folder is empty."}
                    </div>
                  ) : (
                    <ul className="space-y-0.5">
                      {workspaceRootTreeEntries.map((entry) => (
                        <WorkspaceTreeNode
                          key={entry.path}
                          orgId={viewedOrganizationId}
                          entry={entry}
                          organizationSkills={organizationSkills}
                          selectedFilePath={selectedFilePath}
                          selectedSkillTreePath={selectedSkillTreePath}
                          selectedResourcePath={selectedResourcePath}
                          activeEntryPath={activeEntryPath}
                          draggedEntryPath={draggedEntryPath}
                          onSelectFile={handleSelectFile}
                          onSelectSkillFile={handleSelectSkillFile}
                          onSelectResource={handleSelectResource}
                          onFocusEntry={setActiveEntryPath}
                          onDragStartEntry={setDraggedEntryPath}
                          onDragEndEntry={() => setDraggedEntryPath(null)}
                          onCopyLink={(entryToCopy) => void handleCopyEntryLink(entryToCopy)}
                          onCopyAbsolutePath={(entryToCopy) => void handleCopyEntryAbsolutePath(entryToCopy)}
                          onOpenEntry={readDesktopShell()?.openPath
                            ? (entryToOpen) => void handleOpenEntryDefault(entryToOpen)
                            : undefined}
                          onOpenEntryTarget={(entryToOpen, target) => {
                            void handleOpenEntryTarget(entryToOpen, target);
                          }}
                          onStartCreateEntry={handleStartCreateEntry}
                          onCopyEntry={handleCopyEntry}
                          onStartRename={handleStartRename}
                          onStartDelete={handleStartDelete}
                          onMoveEntry={handleMoveEntry}
                          onImportFiles={handleImportFiles}
                          onAddResources={handleAddProjectResources}
                          onCopyResourceLocator={(attachment) => void handleCopyResourceLocator(attachment)}
                          onOpenResource={(attachment) => void handleOpenResourceDefault(attachment)}
                          onUnlinkResource={(project, attachment) => removeProjectResourceAttachment.mutate({ project, attachment })}
                          onOpenSkillAddDialog={() => setSkillAddDialogOpen(true)}
                          unlinkingResourceId={removeProjectResourceAttachment.variables?.attachment.id ?? null}
                          expandedDirectories={expandedDirectories}
                          workspaceLaunchTargets={workspaceLaunchTargets}
                          openingWorkspaceTargetId={openingWorkspaceTargetId}
                          projectResourceGroupsByLibraryPath={projectResourceTree.groupsByLibraryPath}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          ) : null}

          <section
            data-testid="org-workspaces-editor-card"
            data-active-surface={selectedWorkspaceSavePending || uploadWorkspaceImage.isPending ? "workspace-document" : undefined}
            className={cn(
              "rudder-doc-editor-surface flex min-h-[420px] min-w-0 flex-col bg-transparent lg:min-h-0 lg:flex-1",
              (selectedWorkspaceSavePending || uploadWorkspaceImage.isPending) && "active-surface-ring",
            )}
          >
            {showWorkspaceFileTabs ? (
              <div
                data-testid="org-workspaces-editor-tabs"
                role="tablist"
                aria-label="Open files"
                className="rudder-doc-editor-tab-strip rudder-doc-editor-tab-strip--desktop-chrome flex h-[var(--rudder-doc-editor-tab-strip-height)] shrink-0 items-stretch justify-between rounded-tr-[var(--radius-lg)] border-r border-[color:var(--border-base)] bg-transparent"
              >
                <div
                  ref={setOpenFileTabsScrollerRef}
                  data-testid="org-workspaces-editor-tab-scroller"
                  className="rudder-doc-editor-tab-scroller scrollbar-auto-hide flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pl-0 pr-2 pt-1"
                >
                  <>
                    {openFilePaths.map((filePath, index) => {
                      const active = selectedFilePath === filePath;
                      const first = index === 0;
                      const dragging = draggedTabPath === filePath;
                      const dropBefore = tabDropPreview?.targetPath === filePath && tabDropPreview.position === "before";
                      const dropAfter = tabDropPreview?.targetPath === filePath && tabDropPreview.position === "after";
                      return (
                        <div
                          ref={setOpenFileTabElementRef(filePath)}
                          key={filePath}
                          data-testid={`org-workspaces-editor-tab-${filePath}`}
                          draggable={openFilePaths.length > 1}
                          onDragStart={(event) => handleOpenFileTabDragStart(event, filePath)}
                          onDragOver={(event) => handleOpenFileTabDragOver(event, filePath)}
                          onDragLeave={(event) => handleOpenFileTabDragLeave(event, filePath)}
                          onDrop={(event) => handleOpenFileTabDrop(event, filePath)}
                          onDragEnd={handleOpenFileTabDragEnd}
                          onContextMenu={(event) => handleOpenTabContextMenu(event, filePath)}
                          className={cn(
                            "rudder-doc-editor-tab rudder-doc-editor-tab--desktop-no-drag group relative flex min-w-[132px] max-w-[248px] shrink-0 cursor-default items-center border px-1 transition-[box-shadow,opacity,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
                            active
                              ? "rudder-doc-editor-tab--active mb-[-1px] h-[var(--rudder-doc-editor-tab-active-height)] overflow-visible rounded-t-[var(--rudder-doc-editor-tab-radius)] border-[color:var(--border-base)] border-b-[color:var(--surface-elevated)] bg-[color:var(--surface-elevated)] text-foreground shadow-[0_-1px_0_color-mix(in_oklab,var(--foreground)_6%,transparent)]"
                              : "mb-2 h-[var(--rudder-doc-editor-tab-inactive-height)] translate-y-px overflow-hidden rounded-[var(--rudder-doc-editor-tab-radius)] border-transparent text-muted-foreground hover:translate-y-0 hover:bg-[color:var(--rudder-doc-editor-tab-hover-bg)] hover:text-foreground hover:shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_8%,transparent)]",
                            active && first && "rudder-doc-editor-tab--first-active",
                            dragging && "opacity-55",
                            dropBefore && !dragging && "rudder-doc-editor-tab--drop-before",
                            dropAfter && !dragging && "rudder-doc-editor-tab--drop-after",
                          )}
                        >
                          <button
                            type="button"
                            role="tab"
                            aria-selected={active}
                            draggable={false}
                            className="min-w-0 flex-1 truncate rounded-[10px] px-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                            title={filePath}
                            onClick={() => handleSelectFile(filePath)}
                          >
                            {displayWorkspaceFileTabLabel(filePath)}
                          </button>
                          <button
                            type="button"
                            draggable={false}
                            className={cn(
                              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground",
                              active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                            )}
                            aria-label={`Close ${filePath}`}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleCloseFileTab(filePath);
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                    <div aria-hidden="true" className="rudder-doc-editor-tab-drag-spacer mb-2 h-9 min-w-6 flex-1" />
                  </>
                </div>
              </div>
            ) : null}
            {visibleWorkspaceBreadcrumbPath !== null ? (
              <div
                data-testid="org-workspaces-path-breadcrumb"
                className="flex h-[var(--rudder-doc-editor-breadcrumb-height)] shrink-0 items-center justify-between gap-3 overflow-hidden border-x border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] px-3 text-sm text-muted-foreground"
                aria-label="File path"
              >
                <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                  {applyOrganizationSkillBreadcrumbLabels(
                    workspacePathBreadcrumb(
                      visibleWorkspaceBreadcrumbPath,
                      agentWorkspaceEntryByName,
                      visibleWorkspaceBreadcrumbKind,
                      libraryCopy("library", locale),
                    ),
                    selectedVirtualOrganizationSkill,
                  ).map((part, index, parts) => {
                    const isLast = index === parts.length - 1;
                    return (
                      <div key={`${part.path}:${index}`} className="flex min-w-0 items-center gap-1.5">
                        {index > 0 ? <span className="shrink-0 text-muted-foreground/45">/</span> : null}
                        <button
                          type="button"
                          className={cn(
                            "inline-flex min-w-0 rounded-[4px] px-1 py-0.5 text-left font-medium transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                            isLast ? "text-foreground" : "text-muted-foreground",
                          )}
                          title={part.path}
                          onClick={() => {
                            if (part.isFile) {
                              if (requestedSkillId && requestedSkillFilePath) {
                                handleSelectSkillFile(requestedSkillId, requestedSkillFilePath, part.path);
                              } else {
                                handleSelectFile(part.path);
                              }
                            } else if (part.path) {
                              setActiveEntryPath(part.path);
                              focusWorkspaceTreeEntry(part.path);
                              updateSelectedDirectory(searchParams, setSearchParams, part.path);
                            } else {
                              setActiveEntryPath(null);
                              updateSelectedDirectory(searchParams, setSearchParams, null);
                            }
                          }}
                        >
                          <span className="truncate">{part.label}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
                {selectedFileUsesMarkdownEditor ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        aria-label="Document options"
                      >
                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem
                        disabled={!showSelectedMarkdownOutlinePanel}
                        onSelect={() => setMarkdownOutlineCollapsed((collapsed) => !collapsed)}
                      >
                        {markdownOutlineCollapsed ? "Show sections" : "Hide sections"}
                      </DropdownMenuItem>
                      {selectedMarkdownHasHiddenOutlineItems ? (
                        <DropdownMenuCheckboxItem
                          checked={showHiddenMarkdownSections}
                          onCheckedChange={(checked) => setShowHiddenMarkdownSections(checked === true)}
                        >
                          Show hidden sections
                        </DropdownMenuCheckboxItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            ) : null}
            <div
              ref={libraryFindRootRef}
              data-testid="org-workspaces-editor-content"
              className={cn(
                "min-h-0 flex-1 overflow-hidden border-x border-b border-[color:var(--border-base)] bg-[color:var(--surface-elevated)]",
                !showWorkspaceFileTabs && visibleWorkspaceBreadcrumbPath === null && "rounded-[var(--desktop-workspace-radius)] border-t",
              )}
            >
              <IssueDetailFind
                highlightMode="css"
                rootRef={libraryFindRootRef}
                refreshKey={libraryFindRefreshKey}
                searchLabel={libraryCopy("findInLibrary", locale)}
              />
              {selectedProjectResource ? (
                <ProjectResourceDetailPanel
                  project={selectedProjectResource.project}
                  attachment={selectedProjectResource.attachment}
                  workspaceRootPath={workspaceRootPath}
                  workspaceLaunchTargets={workspaceLaunchTargets}
                  selectedWorkspaceLaunchTarget={selectedWorkspaceLaunchTarget}
                  openingWorkspaceTargetId={openingWorkspaceTargetId}
                  onSelectWorkspaceLaunchTarget={handleSelectWorkspaceLaunchTarget}
                  onOpenWorkspaceTarget={(rootPath, target, toastLabel) => {
                    void handleOpenWorkspaceTarget(rootPath, target, toastLabel);
                  }}
                />
              ) : requestedResourceAttachmentId && projectResourceTree.isLoading ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">Loading resource...</div>
              ) : requestedResourceAttachmentId ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">{libraryCopy("resourceNotFoundInProjectLibrary", locale)}</div>
              ) : requestedSkillId ? (
                virtualSkillFileQuery.isLoading ? (
                  <div className="px-4 py-6 text-sm text-muted-foreground">Loading skill...</div>
                ) : virtualSkillFileQuery.error ? (
                  <div className="px-4 py-6 text-sm text-destructive">
                    {virtualSkillFileQuery.error instanceof Error
                      ? virtualSkillFileQuery.error.message
                      : "This skill file could not be loaded."}
                  </div>
                ) : selectedVirtualSkillFileDetail ? (
                  <div
                    ref={setEditorScrollElementRef}
                    data-testid="org-workspaces-virtual-skill-readonly"
                    className="scrollbar-auto-hide h-full min-h-0 overflow-auto bg-[color:var(--surface-elevated)]"
                  >
                    <div className="border-b border-border bg-[color:var(--surface-page)] px-4 py-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Read-only skill</span>
                      {selectedOrganizationSkill?.sourceLabel ? (
                        <>
                          <span aria-hidden="true"> / </span>
                          <span>{selectedOrganizationSkill.sourceLabel}</span>
                        </>
                      ) : null}
                      {selectedOrganizationSkill?.editableReason ? (
                        <>
                          <span aria-hidden="true"> / </span>
                          <span>{selectedOrganizationSkill.editableReason}</span>
                        </>
                      ) : null}
                    </div>
                    {selectedVirtualSkillFileDetail.markdown ? (
                      <article className="mx-auto min-h-full w-full max-w-[880px] px-8 py-8">
                        {selectedVirtualSkillMarkdownParts.frontmatter !== null ? (
                          <details
                            className="group mb-6 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-page)]"
                            data-testid="org-workspaces-virtual-skill-metadata"
                          >
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
                              <span>Metadata</span>
                              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                            </summary>
                            <pre
                              aria-label="Skill metadata"
                              className="overflow-x-auto whitespace-pre-wrap break-words border-t border-[color:var(--border-soft)] px-3 py-2 font-mono text-xs leading-5 text-foreground"
                            >
                              <code>{selectedVirtualSkillMarkdownParts.frontmatter}</code>
                            </pre>
                          </details>
                        ) : null}
                        <MarkdownBody className="rudder-library-document-editor text-[15px] leading-7 text-foreground">
                          {selectedVirtualSkillMarkdownParts.body}
                        </MarkdownBody>
                      </article>
                    ) : (
                      <pre className="overflow-x-auto px-4 py-4 text-xs leading-6 text-foreground">
                        <code>{selectedVirtualSkillContent}</code>
                      </pre>
                    )}
                  </div>
                ) : (
                  <div className="px-4 py-6 text-sm text-muted-foreground">This skill file is not available.</div>
                )
              ) : !selectedFilePath ? (
                <div className="flex h-full min-h-[360px] items-center justify-center px-6 py-10">
                  <div className="flex max-w-md flex-col items-center text-center">
                    <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:var(--surface-page)] text-muted-foreground shadow-[0_0_36px_color-mix(in_oklab,var(--foreground)_8%,transparent)]">
                      <FileText className="h-8 w-8" />
                    </div>
                    <h2 className="text-xl font-semibold text-foreground">No file selected</h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {noSelectionMessage}
                    </p>
                    <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 gap-2 rounded-[5px] border-[color:var(--border-base)] bg-[color:var(--surface-page)] px-4 text-sm"
                        onClick={() => handleStartCreateEntry(emptyStateCreateTarget, "file")}
                        disabled={!workspaceRootPath || !canCreateInsideWorkspaceDirectory(emptyStateCreateTarget.path)}
                        data-testid="org-workspaces-empty-new-document"
                      >
                        <FilePlus2 className="h-4 w-4 text-[color:var(--accent-strong)]" />
                        New document
                      </Button>
                      {workspaceRootPath && selectedWorkspaceLaunchTarget ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 gap-2 rounded-[5px] border-[color:var(--border-base)] bg-[color:var(--surface-page)] px-4 text-sm"
                          onClick={() => {
                            void handleOpenWorkspaceTarget(
                              emptyStateOpenFolderPath,
                              selectedWorkspaceLaunchTarget,
                              selectedDirectoryPath ? "folder" : "workspace",
                            );
                          }}
                          disabled={openingWorkspaceTargetId !== null}
                        >
                          <FolderOpen className="h-4 w-4 text-[color:var(--accent-strong)]" />
                          Open folder
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : fileQuery.isLoading ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">Loading file…</div>
              ) : fileQuery.error ? (
                <div className="px-4 py-6 text-sm text-destructive">{fileQuery.error.message}</div>
              ) : selectedFileDetail?.rootExists === false ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  {selectedFileDetail.message ?? "The shared Library root is not available on this machine yet."}
                </div>
              ) : selectedFileUsesHtmlPreview ? (
                <div
                  ref={setEditorScrollElementRef}
                  data-testid="org-workspaces-html-preview-scroll"
                  className="scrollbar-auto-hide flex h-full min-h-[420px] flex-col overflow-auto bg-white"
                >
                  {viewedOrganizationId && selectedFilePath ? (
                    <WorkspaceHtmlPreview
                      key={`${viewedOrganizationId}:${selectedFilePath}`}
                      organizationId={viewedOrganizationId}
                      filePath={selectedFilePath}
                      htmlContent={selectedEditorContent}
                      viewMode="preview"
                      onViewModeChange={setHtmlFileMode}
                      networkMode={selectedHtmlNetworkMode}
                      onNetworkModeChange={(networkMode) => {
                        setHtmlNetworkSelection({
                          identity: selectedHtmlPreviewIdentity,
                          mode: networkMode,
                        });
                      }}
                      openAction={selectedHtmlFileOpenAction}
                      testIdPrefix="org-workspaces"
                    />
                  ) : null}
                </div>
              ) : canEditSelectedFile ? (
                <div className="flex h-full min-h-0 flex-col">
                  {selectedFileDetail?.message ? (
                    <div className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">
                      {selectedFileDetail.message}
                    </div>
                  ) : null}
                  {selectedWorkspaceSaveError ? (
                    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-destructive">
                      <span>{selectedWorkspaceSaveError instanceof Error
                        ? selectedWorkspaceSaveError.message
                        : "Failed to save workspace file."}</span>
                      {saveWorkspaceFileConflict ? (
                        <Button variant="outline" size="sm" onClick={() => void reloadWorkspaceFileAfterConflict()}>
                          Reload latest
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" onClick={flushCurrentDraft}>
                          Retry
                        </Button>
                      )}
                    </div>
                  ) : null}
                  {selectedFileCanRenderHtml ? (
                    <WorkspaceHtmlPreviewToolbar
                      viewMode="source"
                      onViewModeChange={setHtmlFileMode}
                      openAction={selectedHtmlFileOpenAction}
                      testIdPrefix="org-workspaces"
                    />
                  ) : null}
                  {selectedFileUsesCsvEditor ? (
                    <CsvWorkspaceEditor
                      content={selectedEditorContent}
                      filePath={selectedFilePath}
                      mode={csvFileMode}
                      onChange={handleMarkdownDraftChange}
                      onModeChange={setCsvFileMode}
                      scrollRef={setEditorScrollElementRef}
                    />
                  ) : selectedFileUsesMarkdownEditor ? (
                    <div
                      ref={setEditorScrollElementRef}
                      data-testid="org-workspaces-markdown-editor" data-markdown-scroll-container="true"
                      className="rudder-library-document-editor-scroll scrollbar-auto-hide min-h-[280px] flex-1 overflow-auto bg-[color:var(--surface-elevated)]"
                      onClick={handleMarkdownEditorBlankClick}
                    >
                      <div
                        className={cn(
                          "rudder-library-document-layout mx-auto min-h-full w-full px-8 py-8",
                          renderSelectedMarkdownOutlinePanel
                            ? "rudder-library-document-layout--with-outline max-w-[1180px] xl:grid xl:grid-cols-[minmax(0,880px)_220px] xl:gap-8"
                            : "max-w-[880px]",
                        )}
                      >
                        <div className="min-w-0">
                          {selectedMarkdownParts.frontmatter !== null ? (
                            <details
                              className="group mb-6 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-page)]"
                              data-testid="org-workspaces-frontmatter-editor"
                            >
                              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                                <span>Frontmatter</span>
                                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                              </summary>
                              <textarea
                                value={selectedMarkdownParts.frontmatter}
                                onChange={(event) => handleFrontmatterDraftChange(selectedFilePath, event.target.value)}
                                spellCheck={false}
                                className="block min-h-28 w-full resize-y border-t border-[color:var(--border-soft)] bg-transparent px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none"
                                aria-label="Frontmatter"
                              />
                            </details>
                          ) : null}
                          <MarkdownEditor
                            ref={markdownEditorRef}
                            key={selectedFilePath}
                            engine="codemirror"
                            documentIdentity={`library-file:${selectedFilePath}`}
                            value={selectedMarkdownBodyForEditor}
                            onChange={(nextContent) => handleMarkdownBodyDraftChange(selectedFilePath, nextContent)}
                            mentions={agentWorkspaceMentionOptions}
                            onInlineTokenClick={handleLibraryInlineTokenClick}
                            activateInlineTokensOnPlainClick
                            imageUploadHandler={async (file) => {
                              const asset = await uploadWorkspaceImage.mutateAsync({
                                file,
                                filePath: selectedFilePath,
                              });
                              return asset.contentPath;
                            }}
                            bordered={false}
                            placeholder="Write in Markdown..."
                            contentClassName="rudder-library-document-editor min-h-[420px] text-[15px] leading-7 text-foreground"
                          />
                        </div>
                        {renderSelectedMarkdownOutlinePanel ? (
                          <aside
                            aria-label="Document sections"
                            data-testid="org-workspaces-document-outline"
                            className="rudder-library-document-outline hidden min-w-0 xl:block"
                          >
                            <div className="sticky top-6 border-l border-border/60 py-1 pl-4">
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <div className="text-xs font-medium text-muted-foreground">Sections</div>
                              </div>
                              {selectedMarkdownOutline.length > 0 ? (
                                <nav className="space-y-0.5">
                                  {selectedMarkdownOutline.map((item) => (
                                    <button
                                      key={item.id}
                                      type="button"
                                      className="flex w-full min-w-0 items-center gap-1 rounded px-2 py-1 text-left text-xs leading-5 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                      style={{ paddingLeft: `${8 + Math.max(0, item.level - 1) * 10}px` }}
                                      title={item.title}
                                      onClick={() => scrollToSelectedMarkdownOutlineItem(item)}
                                    >
                                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                                      {item.hidden ? (
                                        <span className="shrink-0 rounded-[3px] bg-muted px-1 py-0 text-[10px] leading-4 text-muted-foreground">
                                          Hidden
                                        </span>
                                      ) : null}
                                    </button>
                                  ))}
                                </nav>
                              ) : (
                                <div className="px-2 py-1 text-xs leading-5 text-muted-foreground">
                                  Hidden sections are off.
                                </div>
                              )}
                            </div>
                          </aside>
                        ) : null}
                      </div>
                    </div>
                  ) : selectedFileUsesCodeEditor ? (
                    <WorkspaceCodeEditor
                      data-testid="org-workspaces-editor-textarea"
                      filePath={selectedFilePath}
                      value={selectedEditorContent}
                      onChange={(nextContent) => handleMarkdownDraftChange(selectedFilePath, nextContent)}
                      scrollRef={setEditorScrollElementRef}
                      ariaLabel="Library code editor"
                    />
                  ) : (
                    <textarea
                      data-testid="org-workspaces-editor-textarea"
                      value={selectedEditorContent}
                      onChange={(event) => handleMarkdownDraftChange(selectedFilePath, event.target.value)}
                      spellCheck={false}
                      ref={setEditorScrollElementRef}
                      className="scrollbar-auto-hide block min-h-[280px] flex-1 overflow-auto border-0 bg-transparent px-4 py-4 font-mono text-sm leading-6 text-foreground outline-none"
                    />
                  )}
                  <div
                    data-testid="org-workspaces-editor-status-bar"
                    className="flex h-8 shrink-0 items-center justify-between gap-4 border-t border-border bg-[color:var(--surface-page)] px-4 text-xs text-muted-foreground"
                  >
                    <div className="flex min-w-0 items-center gap-4">
                      {selectedStatusSegments.map((segment) => (
                        <span key={segment}>{segment}</span>
                      ))}
                    </div>
                    <div className={cn(
                      "flex shrink-0 items-center gap-1.5",
                      selectedWorkspaceSaveError ? "text-destructive" : "text-muted-foreground",
                    )}>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "h-2 w-2 rounded-full",
                          selectedWorkspaceSaveError ? "bg-destructive" : "bg-[color:var(--accent-strong)]",
                        )}
                      />
                      {selectedSaveStatus}
                    </div>
                  </div>
                </div>
              ) : selectedFileDetail?.previewKind === "image" && selectedFileDetail.contentPath ? (
                <div
                  ref={setEditorScrollElementRef}
                  data-testid="org-workspaces-image-preview-scroll"
                  className="scrollbar-auto-hide flex h-full min-h-[420px] items-center justify-center overflow-auto bg-accent/10 p-4"
                >
                  <InspectableImage
                    data-testid="org-workspaces-image-preview"
                    src={selectedFileDetail.contentPath}
                    alt={selectedFilePath ?? "Workspace image preview"}
                    name={selectedFilePath ?? "Workspace image preview"}
                    className="max-h-full max-w-full rounded-md object-contain shadow-sm"
                    previewTestId="org-workspaces-image-preview-dialog"
                    previewTitleFallback="Library image preview"
                    triggerClassName="max-h-full"
                    wrapperClassName="max-h-full"
                  />
                </div>
              ) : (selectedFileDetail?.previewKind === "pdf" || selectedFileDetail?.previewKind === "video" || selectedFileDetail?.previewKind === "audio")
                && selectedFileDetail.contentPath ? (
                <WorkspaceLibraryBinaryPreview cacheKey={`${viewedOrganizationId}:${selectedFileDetail.filePath}`} kind={selectedFileDetail.previewKind} src={selectedFileDetail.contentPath} contentType={selectedFileDetail.contentType} title={selectedFilePath ?? `Library ${selectedFileDetail.previewKind}`} targets={selectedUnsupportedFileLaunchTargets} openingTargetId={openingWorkspaceTargetId} onOpenTarget={(target) => void handleOpenUnsupportedFileTarget(selectedFilePath, target)} scrollRef={setEditorScrollElementRef} />
              ) : selectedFileDetail?.content ? (
                <div
                  ref={setEditorScrollElementRef}
                  data-testid="org-workspaces-readonly-preview-scroll"
                  className="scrollbar-auto-hide h-full min-h-0 overflow-auto"
                >
                  <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
                    {selectedFileDetail.message ?? libraryCopy("readOnlyInLibrary", locale)}
                  </div>
                  <pre className="overflow-x-auto px-4 py-4 text-xs leading-6 text-foreground">
                    <code>{selectedFileDetail.content}</code>
                  </pre>
                </div>
              ) : selectedFileDetail ? (
                <UnsupportedWorkspaceFileLauncher
                  targets={selectedUnsupportedFileLaunchTargets}
                  currentTarget={selectedUnsupportedFileLaunchTarget}
                  openingTargetId={openingWorkspaceTargetId}
                  onOpenTarget={(target) => {
                    void handleOpenUnsupportedFileTarget(selectedFilePath, target);
                  }}
                />
              ) : (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  {libraryCopy("cannotRenderInLibrary", locale)}
                </div>
              )}
            </div>
          </section>

        </div>
      )}
      </div>

      <WorkspaceTabContextMenu
        menu={tabContextMenu}
        ideLabel={primaryIde?.label ?? "IDE"}
        canOpenInIde={Boolean(primaryIde && workspaceRootPath)}
        canCloseOtherTabs={canCloseOtherTabs}
        canCloseTabsToRight={canCloseTabsToRight}
        onClose={() => setTabContextMenu(null)}
        onCopyLink={(filePath) => void handleCopyWorkspaceLink(filePath)}
        onCopyAbsolutePath={(filePath) => void handleCopyWorkspaceAbsolutePath(filePath)}
        onOpenInIde={(filePath) => void handleOpenFileInIde(filePath)}
        onCloseTab={handleCloseFileTab}
        onCloseOtherTabs={handleCloseOtherFileTabs}
        onCloseTabsToRight={handleCloseTabsToRight}
        onCloseAllTabs={handleCloseAllFileTabs}
      />

      <LegacyHeartbeatInstructionsDialog
        open={legacyHeartbeatDialogPath !== null}
        filePath={legacyHeartbeatDialogPath}
        isDeleting={deleteLegacyHeartbeatInstructions.isPending}
        onKeep={handleKeepLegacyHeartbeatFiles}
        onDeleteAll={() => deleteLegacyHeartbeatInstructions.mutate()}
      />

      <Dialog open={createTarget !== null} onOpenChange={(open) => {
        if (!open && !createWorkspaceEntry.isPending) {
          setCreateTarget(null);
          setCreateDraft("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createTarget?.kind === "folder" ? "New folder" : "New file"}</DialogTitle>
            <DialogDescription>
              Create inside {createTarget?.parent.path ?? "this folder"}.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              value={createDraft}
              onChange={(event) => setCreateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !createTarget || !isValidWorkspaceEntryName(createDraft)) return;
                event.preventDefault();
                createWorkspaceEntry.mutate({
                  parent: createTarget.parent,
                  kind: createTarget.kind,
                  name: createDraft,
                });
              }}
              autoFocus
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCreateTarget(null);
                setCreateDraft("");
              }}
              disabled={createWorkspaceEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!createTarget) return;
                createWorkspaceEntry.mutate({
                  parent: createTarget.parent,
                  kind: createTarget.kind,
                  name: createDraft,
                });
              }}
              disabled={!createTarget || !isValidWorkspaceEntryName(createDraft) || createWorkspaceEntry.isPending}
            >
              {createWorkspaceEntry.isPending
                ? "Creating..."
                : createTarget?.kind === "folder"
                  ? "Create folder"
                  : "Create file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameTarget !== null} onOpenChange={(open) => {
        if (!open && !renameWorkspaceEntry.isPending) {
          setRenameTarget(null);
          setRenameDraft("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename entry</DialogTitle>
            <DialogDescription>
              Rename this workspace file or folder without changing its parent folder.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !renameTarget) return;
                event.preventDefault();
                renameWorkspaceEntry.mutate({ entry: renameTarget, name: renameDraft });
              }}
              autoFocus
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRenameTarget(null);
                setRenameDraft("");
              }}
              disabled={renameWorkspaceEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!renameTarget) return;
                renameWorkspaceEntry.mutate({ entry: renameTarget, name: renameDraft });
              }}
              disabled={
                !renameTarget
                || renameDraft.trim().length === 0
                || renameDraft.trim() === renameTarget.name
                || renameWorkspaceEntry.isPending
              }
            >
              {renameWorkspaceEntry.isPending ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => {
        if (!open && !deleteWorkspaceEntry.isPending) setDeleteTarget(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.entityType === "orphaned_agent_workspace"
                ? "Delete deleted agent folder?"
                : "Delete entry"}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.entityType === "orphaned_agent_workspace"
                ? `This folder is no longer linked to an active agent. This will permanently delete ${deleteTarget.path} and everything inside it from the organization Library.`
                : `This will permanently delete ${deleteTarget?.path ?? "this entry"} from the organization Library.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteWorkspaceEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return;
                deleteWorkspaceEntry.mutate(deleteTarget);
              }}
              disabled={!deleteTarget || deleteWorkspaceEntry.isPending}
            >
              {deleteWorkspaceEntry.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SkillLibraryAddDialog
        open={skillAddDialogOpen}
        orgId={viewedOrganizationId}
        onOpenChange={setSkillAddDialogOpen}
      />
    </>
  );
}

export function OrganizationWorkspaces() {
  return <OrganizationWorkspaceBrowser />;
}
